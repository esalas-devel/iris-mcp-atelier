// Types for the InterSystems IRIS Atelier REST API.

export interface IrisConfig {
  serverUrl: string;
  username: string;
  password: string;
  defaultNamespace?: string;
  timeout?: number;
}

export interface AtelierResponse<T = unknown> {
  status: {
    errors: AtelierError[];
    warnings: string[];
  };
  console: string[];
  result: T;
}

export interface AtelierError {
  code: number;
  location: string;
  message: string;
  source?: string;
}

export interface ServerInfo {
  version: string;
  id: string;
  api: number;
  features: string[];
  namespaces: string[];
}

export type DocumentCategory =
  | 'CLS'
  | 'RTN'
  | 'INC'
  | 'MAC'
  | 'INT'
  | 'BAS'
  | 'MVB'
  | 'MVI'
  | 'CSP'
  | 'CSR'
  | 'OTH';

export interface DocumentInfo {
  name: string;
  db: string;
  ts: string;
  upd: boolean;
  cat: DocumentCategory;
  status: string;
  enc: boolean;
  flags: number;
  content?: string[];
  gen: boolean;
  depl: boolean;
}

export interface DocumentContent {
  name: string;
  content: string[];
  enc: boolean;
  ts: string;
  cat: DocumentCategory;
}

export interface CompileResult {
  console: string[];
  errors: AtelierError[];
}

export interface QueryResult {
  content: Array<Record<string, unknown>>;
}

export interface SearchResult {
  doc: string;
  line: number;
  text: string;
}

export interface DocumentListOptions {
  type?: DocumentCategory | 'ALL';
  generated?: boolean;
  filter?: string;
}
