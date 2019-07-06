"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typescript_1 = require("typescript");
const { resolve, dirname, relative } = require("path");
class Module {
    constructor(tc, exports, basedir) {
        this.tc = tc;
        this.exports = exports;
        this.basedir = basedir;
    }
    gatherSymbols(symbols, target, parentID) {
        for (const symbol of symbols) {
            let item = this.itemForSymbol(symbol, parentID);
            if (item)
                target[name(symbol)] = item;
        }
    }
    itemForSymbol(symbol, parentID) {
        let id = parentID + name(symbol), kind;
        if (symbol.flags & typescript_1.SymbolFlags.PropertyOrAccessor)
            kind = "property";
        else if (symbol.flags & typescript_1.SymbolFlags.Method)
            kind = "method";
        else if (symbol.flags & typescript_1.SymbolFlags.EnumMember)
            kind = "enummember";
        else if (symbol.flags & typescript_1.SymbolFlags.Class)
            kind = "class";
        else if (symbol.flags & typescript_1.SymbolFlags.Interface)
            kind = "interface";
        else if (symbol.flags & typescript_1.SymbolFlags.Enum)
            kind = "enum";
        else if (symbol.flags & typescript_1.SymbolFlags.TypeAlias)
            kind = "typealias";
        else if (symbol.flags & typescript_1.SymbolFlags.Variable)
            kind = "variable";
        else if (symbol.flags & typescript_1.SymbolFlags.TypeParameter)
            kind = "typeparam";
        else
            throw new Error(`Can not determine a kind for symbol ${symbol.escapedName} with flags ${symbol.flags}`);
        let binding = { kind, id }, type = this.symbolType(symbol);
        if (hasDecl(symbol))
            this.addSourceData(decl(symbol), binding);
        let params = this.getTypeParams(decl(symbol), id);
        if (params)
            binding.typeParams = params;
        let mods = symbol.valueDeclaration ? typescript_1.getCombinedModifierFlags(symbol.valueDeclaration) : 0;
        if (mods & typescript_1.ModifierFlags.Abstract)
            binding.abstract = true;
        if ((mods & typescript_1.ModifierFlags.Readonly) || (symbol.flags & typescript_1.SymbolFlags.GetAccessor))
            binding.readonly = true;
        if ((mods & typescript_1.ModifierFlags.Private) || binding.description && /@internal\b/.test(binding.description))
            return null;
        return Object.assign({}, binding, this.getType(type, id, !["property", "method", "variable"].includes(kind)));
    }
    getType(type, id, describe = false) {
        if (type.flags & typescript_1.TypeFlags.Any)
            return { type: "any" };
        if (type.flags & typescript_1.TypeFlags.String)
            return { type: "string" };
        if (type.flags & typescript_1.TypeFlags.Number)
            return { type: "number" };
        if (type.flags & typescript_1.TypeFlags.BigInt)
            return { type: "BigInt" };
        if (type.flags & typescript_1.TypeFlags.ESSymbol)
            return { type: "Symbol" };
        if (type.flags & typescript_1.TypeFlags.Boolean)
            return { type: "boolean" };
        if (type.flags & typescript_1.TypeFlags.Undefined)
            return { type: "undefined" };
        if (type.flags & typescript_1.TypeFlags.Null)
            return { type: "null" };
        if (type.flags & typescript_1.TypeFlags.Literal)
            return { type: JSON.stringify(type.value) };
        if (type.flags & typescript_1.TypeFlags.Never)
            return { type: "never" };
        // FIXME enums, aliases
        if (type.flags & typescript_1.TypeFlags.UnionOrIntersection)
            return {
                type: type.flags & typescript_1.TypeFlags.Union ? "union" : "intersection",
                typeArgs: type.types.map(type => this.getType(type, id))
            };
        if (type.flags & typescript_1.TypeFlags.TypeParameter)
            return {
                type: "typeparam",
                typeSource: this.typeSource(type),
            };
        if (type.flags & typescript_1.TypeFlags.Object) {
            if ((type.objectFlags & typescript_1.ObjectFlags.Reference) == 0)
                return this.getTypeDesc(type, id);
            let call = type.getCallSignatures(), strIndex = type.getStringIndexType(), numIndex = type.getNumberIndexType();
            if (call.length)
                return this.addCallSignature(call[0], { type: "Function" }, id);
            if (strIndex)
                return { type: "Object", typeArgs: [this.getType(strIndex, id + "^0")] };
            if (numIndex)
                return { type: "Array", typeArgs: [this.getType(numIndex, id + "^0")] };
            let result = { type: name(type.symbol), typeSource: this.typeSource(type) };
            let typeArgs = type.typeArguments;
            if (typeArgs && typeArgs.length)
                result.typeArgs = typeArgs.map(arg => this.getType(arg, id));
            return result;
        }
        throw new Error(`Unsupported type ${this.tc.typeToString(type)}`);
    }
    getTypeDesc(type, id) {
        let call = type.getCallSignatures(), props = type.getProperties();
        // FIXME array/function types
        // FIXME figure out how type params vs type args are represented
        if (type.symbol.flags & typescript_1.SymbolFlags.Class) {
            let out = { type: "class" };
            let ctor = type.getConstructSignatures(), ctorNode;
            if (ctor.length && (ctorNode = ctor[0].getDeclaration())) {
                out.construct = Object.assign({}, this.addSourceData(ctorNode, { kind: "constructor", id: id + "^constructor" }), { type: "Function", params: this.getParams(ctor[0], id) });
            }
            props = props.filter(prop => prop.escapedName != "prototype");
            // FIXME I haven't found a less weird way to get the instance type
            let instanceType = ctor.length && ctor[0].getReturnType();
            if (instanceType) {
                let protoProps = instanceType.getProperties();
                if (protoProps.length)
                    this.gatherSymbols(protoProps, out.instanceProperties = {}, id + ".");
            }
            if (props.length)
                this.gatherSymbols(props, out.properties = {}, id + "^");
            let classDecl = decl(type.symbol);
            if (typescript_1.isClassLike(classDecl) && classDecl.heritageClauses) {
                for (let heritage of classDecl.heritageClauses) {
                    let parents = heritage.types.map(node => this.getType(this.tc.getTypeAtLocation(node), id));
                    if (heritage.token == typescript_1.SyntaxKind.ExtendsKeyword)
                        out.extends = parents[0];
                    else
                        out.implements = parents;
                }
            }
            return out;
        }
        let out = { type: type.symbol.flags & typescript_1.SymbolFlags.Interface ? "interface" : "Object" };
        if (call.length)
            this.addCallSignature(call[0], out, id);
        if (props.length)
            this.gatherSymbols(props, out.properties = {}, id + ".");
        return out;
    }
    typeSource(type) {
        return relative(process.cwd(), decl(type.symbol).getSourceFile().fileName);
    }
    getParams(signature, id) {
        return signature.getParameters().map(param => {
            let result = this.getType(this.symbolType(param), id + "^" + param.escapedName);
            result.name = name(param);
            let deflt = param.valueDeclaration && param.valueDeclaration.initializer;
            if (deflt)
                result.default = deflt.getSourceFile().text.slice(deflt.pos, deflt.end).trim();
            if (deflt || (param.flags & typescript_1.SymbolFlags.Optional))
                result.optional = true;
            return result;
        });
    }
    getTypeParams(decl, id) {
        let params = decl.typeParameters;
        return !params ? null : params.map(param => {
            let sym = this.tc.getSymbolAtLocation(param.name);
            let type = this.getType(this.symbolType(sym), id + "^" + name(sym));
            type.name = name(sym);
            let constraint = typescript_1.getEffectiveConstraintOfTypeParameter(param), cType;
            if (constraint && (cType = this.tc.getTypeAtLocation(constraint)))
                type.implements = [this.getType(cType, id)];
            if (param.default)
                type.default = param.getSourceFile().text.slice(param.default.pos, param.default.end).trim();
            return type;
        });
    }
    addCallSignature(signature, target, id) {
        target.params = this.getParams(signature, id);
        let ret = signature.getReturnType();
        if (!(ret.flags & typescript_1.TypeFlags.Void))
            target.returns = this.getType(ret, id);
        return target;
    }
    symbolType(symbol) {
        let type = this.tc.getTypeOfSymbolAtLocation(symbol, decl(symbol));
        // FIXME this is weird and silly but for interface declarations TS gives a symbol type of any
        if (type.flags & typescript_1.TypeFlags.Any)
            type = this.tc.getDeclaredTypeOfSymbol(symbol);
        return type;
    }
    addSourceData(node, target) {
        let comment = getComment(node.kind == typescript_1.SyntaxKind.VariableDeclaration ? node.parent.parent : node);
        if (comment)
            target.description = comment;
        const sourceFile = node.getSourceFile();
        if (!sourceFile)
            return target; // Synthetic node
        let { pos } = node;
        while (typescript_1.isWhiteSpaceLike(sourceFile.text.charCodeAt(pos)))
            ++pos;
        const { line, character } = typescript_1.getLineAndCharacterOfPosition(sourceFile, pos);
        target.loc = { file: relative(process.cwd(), sourceFile.fileName), line: line + 1, column: character };
        return target;
    }
}
function name(symbol) { return symbol.escapedName; }
function decl(symbol) {
    let result = symbol.valueDeclaration || symbol.declarations[0];
    if (!result)
        throw new Error(`No declaration available for symbole ${symbol.escapedName}`);
    return result;
}
function hasDecl(symbol) {
    return !!symbol.valueDeclaration || symbol.declarations.length > 0;
}
function getComment(node) {
    let { pos } = node;
    const sourceFile = node.getSourceFile();
    if (!sourceFile)
        return ""; // Synthetic node
    const { text } = sourceFile;
    let result = "", blankLine = false;
    while (pos < text.length) {
        const ch = text.charCodeAt(pos);
        if (ch === 47) { // slash
            const nextCh = text.charCodeAt(pos + 1);
            if (nextCh === 47) {
                if (blankLine) {
                    blankLine = false;
                    result = "";
                }
                let start = -1;
                pos += 2;
                for (; pos < text.length; ++pos) {
                    const ch = text.charCodeAt(pos);
                    if (start < 0 && !typescript_1.isWhiteSpaceSingleLine(ch))
                        start = pos;
                    if (typescript_1.isLineBreak(ch))
                        break;
                }
                if (start > 0) {
                    let line = text.substr(start, pos - start);
                    result += (result && !/\s$/.test(result) ? " " : "") + line;
                }
            }
            else if (nextCh === 42) { // asterisk
                if (blankLine) {
                    blankLine = false;
                    result = "";
                }
                const start = pos + 2;
                for (pos = start; pos < text.length; ++pos)
                    if (text.charCodeAt(pos) === 42 /* asterisk */ && text.charCodeAt(pos + 1) === 47 /* slash */)
                        break;
                result += text.substr(start, pos - start);
                pos += 2;
            }
        }
        else if (typescript_1.isWhiteSpaceLike(ch)) {
            pos++;
            if (ch == 10 && text.charCodeAt(pos) == 10)
                blankLine = true;
        }
        else {
            break;
        }
    }
    return result;
}
function gather({ filename, items = Object.create(null) }) {
    const configPath = typescript_1.findConfigFile(filename, typescript_1.sys.fileExists);
    const host = typescript_1.createCompilerHost({});
    const options = configPath ? typescript_1.getParsedCommandLineOfConfigFile(configPath, {}, host).options : {};
    const program = typescript_1.createProgram({ rootNames: [filename], options, host });
    const tc = program.getTypeChecker();
    const exports = tc.getExportsOfModule(tc.getSymbolAtLocation(program.getSourceFile(filename)));
    const basedir = resolve(dirname(configPath || filename));
    const module = new Module(tc, exports, basedir);
    module.gatherSymbols(exports, items, "");
    return items;
}
exports.gather = gather;
//# sourceMappingURL=index.js.map