import {
  getCombinedModifierFlags, findConfigFile, createCompilerHost, getParsedCommandLineOfConfigFile, createProgram, sys,
  getEffectiveConstraintOfTypeParameter,
  getLineAndCharacterOfPosition, isWhiteSpaceLike, isWhiteSpaceSingleLine, isLineBreak,
  isClassLike,
  TypeChecker,
  Symbol, SymbolFlags, ModifierFlags,
  Type, TypeFlags, ObjectType, TypeReference, ObjectFlags, LiteralType, UnionOrIntersectionType, Signature,
  Node, SyntaxKind, TypeParameterDeclaration,
} from "typescript"

const {resolve, dirname, relative} = require("path")

type BindingKind = "class" | "enum" | "enummember" | "interface" | "variable" | "property" | "method" |
  "typealias" | "typeparam" | "constructor" | "parameter"

type Loc = {file: string, line: number, column: number}

type Binding = {
  kind: BindingKind,
  id: string,
  description?: string,
  loc?: Loc,
  typeParams?: readonly ParamType[],
  exported?: boolean,
  abstract?: boolean,
  readonly?: boolean,
}

type BindingType = {
  type: string,
  typeSource?: string, // missing means this is a built-in type
  typeParamID?: string,
  properties?: {[name: string]: Item},
  instanceProperties?: {[name: string]: Item},
  typeArgs?: readonly BindingType[],
  params?: readonly ParamType[],
  returns?: BindingType,
  extends?: BindingType,
  implements?: readonly BindingType[],
  construct?: Item
}

type ParamType = BindingType & {
  name: string,
  optional?: boolean,
  default?: string
}

type Item = Binding & BindingType

class Module {
  constructor(readonly tc: TypeChecker,
              readonly exports: readonly Symbol[],
              readonly basedir: string) {}

  gatherSymbols(symbols: readonly Symbol[], target: {[name: string]: any}, parentID: string) {
    for (const symbol of symbols) {
      let item = this.itemForSymbol(symbol, parentID)
      if (item) target[name(symbol)] = item
    }
  }

  itemForSymbol(symbol: Symbol, parentID: string): Item | null {
    let id = parentID + name(symbol), kind: BindingKind
    if (symbol.flags & SymbolFlags.PropertyOrAccessor) kind = "property"
    else if (symbol.flags & SymbolFlags.Method) kind = "method"
    else if (symbol.flags & SymbolFlags.EnumMember) kind = "enummember"
    else if (symbol.flags & SymbolFlags.Class) kind = "class"
    else if (symbol.flags & SymbolFlags.Interface) kind = "interface"
    else if (symbol.flags & SymbolFlags.Enum) kind = "enum"
    else if (symbol.flags & SymbolFlags.TypeAlias) kind = "typealias"
    else if (symbol.flags & SymbolFlags.Variable) kind = "variable"
    else if (symbol.flags & SymbolFlags.TypeParameter) kind = "typeparam"
    else throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`)

    let binding: Binding = {kind, id}, type = this.symbolType(symbol)
    if (hasDecl(symbol)) this.addSourceData(decl(symbol), binding)
    let params = this.getTypeParams(decl(symbol), id)
    if (params) binding.typeParams = params

    let mods = symbol.valueDeclaration ? getCombinedModifierFlags(symbol.valueDeclaration) : 0
    if (mods & ModifierFlags.Abstract) binding.abstract = true
    if ((mods & ModifierFlags.Readonly) || (symbol.flags & SymbolFlags.GetAccessor)) binding.readonly = true
    if ((mods & ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description)) return null
    
    return {...binding, ...this.getType(type, id, !["property", "method", "variable"].includes(kind))}
  }

  getType(type: Type, id: string, describe = false): BindingType {
    if (type.flags & TypeFlags.Any) return {type: "any"}
    if (type.flags & TypeFlags.String) return {type: "string"}
    if (type.flags & TypeFlags.Number) return {type: "number"}
    if (type.flags & TypeFlags.BigInt) return {type: "BigInt"}
    if (type.flags & TypeFlags.ESSymbol) return {type: "Symbol"}
    if (type.flags & TypeFlags.Boolean) return {type: "boolean"}
    if (type.flags & TypeFlags.Undefined) return {type: "undefined"}
    if (type.flags & TypeFlags.Null) return {type: "null"}
    if (type.flags & TypeFlags.Literal) return {type: JSON.stringify((type as LiteralType).value)}
    if (type.flags & TypeFlags.Never) return {type: "never"}

    // FIXME enums, aliases

    if (type.flags & TypeFlags.UnionOrIntersection) return {
      type: type.flags & TypeFlags.Union ? "union" : "intersection",
      typeArgs: (type as UnionOrIntersectionType).types.map(type => this.getType(type, id))
    }

    if (type.flags & TypeFlags.TypeParameter) return {
      type: name(type.symbol)
    }

    if (type.flags & TypeFlags.Object) {
      if (((type as ObjectType).objectFlags & ObjectFlags.Reference) == 0)
        return this.getTypeDesc(type as ObjectType, id)
      let call = type.getCallSignatures(), strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType()
      if (call.length) return this.addCallSignature(call[0], {type: "Function"}, id)
      if (strIndex) return {type: "Object", typeArgs: [this.getType(strIndex, id + "^0")]}
      if (numIndex) return {type: "Array", typeArgs: [this.getType(numIndex, id + "^0")]}
      let result: BindingType = {type: name(type.symbol), typeSource: this.typeSource(type)}
      let typeArgs = (type as TypeReference).typeArguments
      if (typeArgs && typeArgs.length) result.typeArgs = typeArgs.map(arg => this.getType(arg, id))
      return result
    }

    throw new Error(`Unsupported type ${this.tc.typeToString(type)}`)
  }

  getTypeDesc(type: ObjectType, id: string): BindingType {
    let call = type.getCallSignatures(), props = type.getProperties()
    // FIXME array/function types
    // FIXME figure out how type params vs type args are represented
    if (type.symbol.flags & SymbolFlags.Class) {
      let out: BindingType = {type: "class"}
      let ctor = type.getConstructSignatures(), ctorNode
      if (ctor.length && (ctorNode = ctor[0].getDeclaration())) {
        out.construct = {...this.addSourceData(ctorNode, {kind: "constructor", id: id + "^constructor"}),
                         type: "Function",
                         params: this.getParams(ctor[0], id)}
      }
      props = props.filter(prop => prop.escapedName != "prototype")

      // FIXME I haven't found a less weird way to get the instance type
      let instanceType = ctor.length && ctor[0].getReturnType()
      if (instanceType) {
        let protoProps = instanceType.getProperties()
        if (protoProps.length) this.gatherSymbols(protoProps, out.instanceProperties = {}, id + ".")
      }
      if (props.length) this.gatherSymbols(props, out.properties = {}, id + "^")
      let classDecl = decl(type.symbol)
      if (isClassLike(classDecl) && classDecl.heritageClauses) {
        for (let heritage of classDecl.heritageClauses) {
          let parents = heritage.types.map(node => this.getType(this.tc.getTypeAtLocation(node), id))
          if (heritage.token == SyntaxKind.ExtendsKeyword) out.extends = parents[0]
          else out.implements = parents
        }
      }
      return out
    }

    let out: BindingType = {type: type.symbol.flags & SymbolFlags.Interface ? "interface" : "Object"}
    if (call.length) this.addCallSignature(call[0], out, id)
    if (props.length) this.gatherSymbols(props, out.properties = {}, id + ".")
    return out
  }

  typeSource(type: Type) {
    return relative(process.cwd(), decl(type.symbol).getSourceFile().fileName)
  }

  getParams(signature: Signature, id: string): ParamType[] {
    return signature.getParameters().map(param => {
      let result = this.getType(this.symbolType(param), id + "^" + param.escapedName) as ParamType
      result.name = name(param)
      let deflt: Node = param.valueDeclaration && (param.valueDeclaration as any).initializer
      if (deflt) result.default = deflt.getSourceFile().text.slice(deflt.pos, deflt.end).trim()
      if (deflt || (param.flags & SymbolFlags.Optional)) result.optional = true
      return result
    })
  }

  getTypeParams(decl: Node, id: string): ParamType[] | null {
    let params = (decl as any).typeParameters as TypeParameterDeclaration[]
    return !params ? null : params.map(param => {
      let sym = this.tc.getSymbolAtLocation(param.name)!
      let type = this.getType(this.symbolType(sym), id + "^" + name(sym)) as ParamType
      type.name = name(sym)
      let constraint = getEffectiveConstraintOfTypeParameter(param), cType
      if (constraint && (cType = this.tc.getTypeAtLocation(constraint)))
        type.implements = [this.getType(cType, id)]
      if (param.default)
        type.default = param.getSourceFile().text.slice(param.default.pos, param.default.end).trim()
      return type
    })
  }

  addCallSignature(signature: Signature, target: BindingType, id: string) {
    target.params = this.getParams(signature, id)
    let ret = signature.getReturnType()
    if (!(ret.flags & TypeFlags.Void)) target.returns = this.getType(ret, id)
    return target
  }

  symbolType(symbol: Symbol) {
    let type = this.tc.getTypeOfSymbolAtLocation(symbol, decl(symbol))
    // FIXME this is weird and silly but for interface declarations TS gives a symbol type of any
    if (type.flags & TypeFlags.Any) type = this.tc.getDeclaredTypeOfSymbol(symbol)
    return type
  }

  addSourceData(node: Node, target: Binding) {
    let comment = getComment(node.kind == SyntaxKind.VariableDeclaration ? node.parent.parent : node)
    if (comment) target.description = comment
    const sourceFile = node.getSourceFile()
    if (!sourceFile) return target // Synthetic node
    let {pos} = node
    while (isWhiteSpaceLike(sourceFile.text.charCodeAt(pos))) ++pos
    const {line, character} = getLineAndCharacterOfPosition(sourceFile, pos)
    target.loc = {file: relative(process.cwd(), sourceFile.fileName), line: line + 1, column: character}
    return target
  }
}

function name(symbol: Symbol) { return symbol.escapedName as string }

function decl(symbol: Symbol) {
  let result = symbol.valueDeclaration || symbol.declarations[0]
  if (!result) throw new Error(`No declaration available for symbole ${symbol.escapedName}`)
  return result
}

function hasDecl(symbol: Symbol) {
  return !!symbol.valueDeclaration || symbol.declarations.length > 0
}

function getComment(node: Node) {
  let {pos} = node
  const sourceFile = node.getSourceFile()
  if (!sourceFile) return "" // Synthetic node
  const {text} = sourceFile
  let result = "", blankLine = false
  while (pos < text.length) {
    const ch = text.charCodeAt(pos)
    if (ch === 47) { // slash
      const nextCh = text.charCodeAt(pos + 1)
      if (nextCh === 47) {
        if (blankLine) {
          blankLine = false
          result = ""
        }
        let start = -1
        pos += 2
        for (; pos < text.length; ++pos) {
          const ch = text.charCodeAt(pos)
          if (start < 0 && !isWhiteSpaceSingleLine(ch)) start = pos
          if (isLineBreak(ch)) break
        }
        if (start > 0) {
          let line = text.substr(start, pos - start)
          result += (result && !/\s$/.test(result) ? " " : "") + line
        }
      } else if (nextCh === 42) { // asterisk
        if (blankLine) {
          blankLine = false
          result = ""
        }
        const start = pos + 2
        for (pos = start; pos < text.length; ++pos)
          if (text.charCodeAt(pos) === 42 /* asterisk */ && text.charCodeAt(pos + 1) === 47 /* slash */) break
        result += text.substr(start, pos - start)
        pos += 2
      }
    } else if (isWhiteSpaceLike(ch)) {
      pos++
      if (ch == 10 && text.charCodeAt(pos) == 10) blankLine = true
    } else {
      break
    }
  }
  return result
}

export function gather({filename, items = Object.create(null)}: {filename: string, items?: {[name: string]: any}}) {
  const configPath = findConfigFile(filename, sys.fileExists)
  const host = createCompilerHost({})
  const options = configPath ? getParsedCommandLineOfConfigFile(configPath, {}, host as any)!.options : {}
  const program = createProgram({rootNames: [filename], options, host})

  const tc = program.getTypeChecker()
  const exports = tc.getExportsOfModule(tc.getSymbolAtLocation(program.getSourceFile(filename)!)!)
  const basedir = resolve(dirname(configPath || filename))
  const module = new Module(tc, exports, basedir)
  module.gatherSymbols(exports, items, "")
  
  return items
}
