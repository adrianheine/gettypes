/// An item consists of a binding and a type
export type Item = Binding & Type

export interface SourceDataHolder {
  description?: string,
  loc?: {file: string, line: number, column: number}
}

/// A binding
export type Binding = SourceDataHolder & {
  kind: "class" | "enum" | "enummember" | "interface" | "variable" | "property" | "method" |
    "typealias" | "typeparam" | "constructor" | "function" | "parameter" | "reexport"
  id: string,
  abstract?: boolean,
  readonly?: boolean,
  optional?: boolean
}

// Mixins for types
export type Param = Type & SourceDataHolder & {
  name?: string,
  id: string,
  optional?: boolean,
  rest?: boolean,
  default?: string
}

export interface TypeParamsHolder {
  typeParams?: readonly TypeParam[],
}

export type TypeParam = Param & {
  type: "typeparam",
  implements?: readonly Type[],
}

export type CallableType = TypeParamsHolder & {
  params?: readonly Param[],
  returns?: Type,
}

type ClassBase = TypeParamsHolder & {
  properties?: {[name: string]: Item},
  implements?: readonly Type[],
}

/// A type
export type Type = Class | Enum | Function | Interface | Object | TypeParamReference | TypeReference

export type Class = ClassBase & {
  type: "class",
  construct?: Function,
  extends?: Type,
  instanceProperties?: {[name: string]: Item},
}

export interface Enum {
  type: "enum",
  properties: {[name: string]: {
    type: string
    typeSource: string
  }}
}

export type Function = CallableType & {
  type: "Function"
}

export type Interface = CallableType & ClassBase & {
  type: "interface"
}

export type Object = CallableType & {
  type: "Object",
  properties?: {[name: string]: Item}
}

type TypeParamReference = {
  type: string
  typeParamSource: string,
}

export type TypeReference = {
  type: string,
  typeArgs?: readonly Type[],
  typeSource?: string, // missing means this is a built-in type
}
