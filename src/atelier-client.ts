import {
  IrisConfig,
  AtelierResponse,
  ServerInfo,
  DocumentInfo,
  DocumentContent,
  CompileResult,
  QueryResult,
  SearchResult,
  DocumentListOptions,
  DocumentCategory,
} from './types.js';

/**
 * Thin client around the InterSystems IRIS Atelier REST API.
 * Only implements the endpoints used by this MCP server.
 */
export class AtelierClient {
  private config: IrisConfig;
  private authHeader: string;
  private sessionCookie: string | null = null;

  constructor(config: IrisConfig) {
    this.config = config;
    this.authHeader =
      'Basic ' +
      Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }

  /**
   * Extract the CSP session cookie from a Set-Cookie header.
   * Atelier issues a cookie like `CSPSESSIONID-SP-57773-UP-csp-=xxx; path=/;`.
   */
  private extractSessionCookie(setCookieHeader: string | null): string | null {
    if (!setCookieHeader) return null;
    const match = setCookieHeader.match(/(CSPSESSIONID[^=]*=[^;]+)/i);
    return match ? match[1] : null;
  }

  /** Invalidate the current session so the next request re-authenticates. */
  public clearSession(): void {
    this.sessionCookie = null;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<AtelierResponse<T>> {
    const url = `${this.config.serverUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.sessionCookie) {
      headers['Cookie'] = this.sessionCookie;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeout || 30000,
    );

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // Reuse the session cookie on subsequent requests
      const setCookie = response.headers.get('set-cookie');
      const newSession = this.extractSessionCookie(setCookie);
      if (newSession) {
        this.sessionCookie = newSession;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as AtelierResponse<T>;
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Request timeout after ${this.config.timeout || 30000}ms`,
        );
      }
      throw error;
    }
  }

  /**
   * Throw if the Atelier response carries error entries.
   * Called by tools where errors must bubble up (queries, etc.) but not by
   * the compile endpoint, which wants structured error objects back.
   */
  private checkAtelierErrors<T>(response: AtelierResponse<T>): void {
    if (response.status?.errors && response.status.errors.length > 0) {
      const errorMessages = response.status.errors
        .map((e) => e.message || `Error ${e.code}`)
        .join('; ');
      throw new Error(`IRIS Error: ${errorMessages}`);
    }
  }

  // ============ SERVER INFO ============

  async getServerInfo(): Promise<ServerInfo> {
    const response = await this.request<{ content: ServerInfo }>(
      'GET',
      '/api/atelier/',
    );
    return response.result.content;
  }

  async getNamespaces(): Promise<string[]> {
    const info = await this.getServerInfo();
    return info.namespaces;
  }

  // ============ DOCUMENTS ============

  /** Some document types use ISO-8859-1 rather than UTF-8 on disk. */
  private shouldUseBinaryMode(documentName: string): boolean {
    const lower = documentName.toLowerCase();
    return lower.endsWith('.csp') || lower.endsWith('.csr');
  }

  async listDocuments(
    namespace: string,
    options: DocumentListOptions = {},
  ): Promise<DocumentInfo[]> {
    const { type = 'ALL', generated = false, filter } = options;
    const docType = type === 'ALL' ? '*' : type.toLowerCase();

    let path = `/api/atelier/v1/${encodeURIComponent(namespace)}/docnames/${docType}`;
    const params: string[] = [];
    if (generated) params.push('generated=1');
    if (filter) params.push(`filter=${encodeURIComponent(filter)}`);
    if (params.length > 0) path += '?' + params.join('&');

    const response = await this.request<{ content: DocumentInfo[] }>(
      'GET',
      path,
    );
    return response.result.content || [];
  }

  async getDocument(
    namespace: string,
    documentName: string,
  ): Promise<DocumentContent> {
    const useBinary = this.shouldUseBinaryMode(documentName);
    const binaryParam = useBinary ? '?binary=1' : '';
    const path = `/api/atelier/v1/${encodeURIComponent(namespace)}/doc/${encodeURIComponent(documentName)}${binaryParam}`;
    const response = await this.request<DocumentContent>('GET', path);
    return response.result;
  }

  /**
   * Convenience: read a document and return its decoded content as a string.
   * CSP files come back base64-encoded in latin1; everything else is plain text.
   */
  async getDocumentContent(
    namespace: string,
    documentName: string,
  ): Promise<string> {
    const doc = await this.getDocument(namespace, documentName);
    if (doc.enc) {
      const base64Content = doc.content.join('');
      const buffer = Buffer.from(base64Content, 'base64');
      return buffer.toString('latin1');
    }
    return doc.content.join('\n');
  }

  async putDocument(
    namespace: string,
    documentName: string,
    content: string | string[],
    options: { ignoreConflict?: boolean } = {},
  ): Promise<DocumentInfo> {
    const path = `/api/atelier/v1/${encodeURIComponent(namespace)}/doc/${encodeURIComponent(documentName)}`;
    const useBinary = this.shouldUseBinaryMode(documentName);

    let body: { enc: boolean; content: string[] };

    if (useBinary) {
      const contentStr = Array.isArray(content) ? content.join('\n') : content;
      const buffer = Buffer.from(contentStr, 'latin1');
      body = { enc: true, content: [buffer.toString('base64')] };
    } else {
      const contentArray = Array.isArray(content)
        ? content
        : content.split('\n');
      body = { enc: false, content: contentArray };
    }

    const queryParams = options.ignoreConflict ? '?ignoreConflict=1' : '';
    const response = await this.request<DocumentInfo>(
      'PUT',
      path + queryParams,
      body,
    );
    return response.result;
  }

  async deleteDocument(
    namespace: string,
    documentName: string,
  ): Promise<void> {
    const path = `/api/atelier/v1/${encodeURIComponent(namespace)}/doc/${encodeURIComponent(documentName)}`;
    await this.request<void>('DELETE', path);
  }

  // ============ COMPILE ============

  async compile(
    namespace: string,
    documents: string[],
    options: { flags?: string } = {},
  ): Promise<CompileResult> {
    const flags = options.flags || 'cuk';
    const path = `/api/atelier/v1/${encodeURIComponent(namespace)}/action/compile?flags=${encodeURIComponent(flags)}`;
    const response = await this.request<CompileResult[]>(
      'POST',
      path,
      documents,
    );
    return {
      console: response.console || [],
      errors: response.status?.errors || [],
    };
  }

  // ============ SQL QUERY ============

  async executeQuery(
    namespace: string,
    query: string,
  ): Promise<QueryResult> {
    const path = `/api/atelier/v1/${encodeURIComponent(namespace)}/action/query`;
    const response = await this.request<QueryResult>('POST', path, {
      query,
      parameters: [],
    });
    this.checkAtelierErrors(response);
    return response.result;
  }

  // ============ SEARCH ============

  async search(
    namespace: string,
    searchText: string,
    options: {
      type?: DocumentCategory;
      system?: boolean;
      generated?: boolean;
      maxResults?: number;
    } = {},
  ): Promise<SearchResult[]> {
    const {
      type,
      system = false,
      generated = false,
      maxResults = 100,
    } = options;

    // Map category → Atelier file glob
    let files = '*';
    if (type) {
      const typeMap: Record<string, string> = {
        CLS: '*.cls',
        MAC: '*.mac',
        RTN: '*.mac,*.int,*.inc',
        INC: '*.inc',
        INT: '*.int',
        CSP: '*.csp',
      };
      files = typeMap[type] || '*.cls';
    }

    const params = new URLSearchParams({
      query: searchText,
      files,
      regex: '0',
      sys: system ? '1' : '0',
      gen: generated ? '1' : '0',
      max: maxResults.toString(),
    });

    const path = `/api/atelier/v2/${encodeURIComponent(namespace)}/action/search?${params.toString()}`;

    try {
      const response = await this.request<SearchResult[]>('GET', path);

      const rawResults = response.result as unknown as Array<{
        doc: string;
        matches: Array<{
          member?: string;
          line?: string;
          text: string;
          attr?: string;
        }>;
      }>;

      const results: SearchResult[] = [];
      for (const docResult of rawResults || []) {
        for (const match of docResult.matches || []) {
          results.push({
            doc: docResult.doc,
            line: match.line ? parseInt(match.line, 10) : 0,
            text: match.text,
          });
        }
      }
      return results;
    } catch {
      // Fall back to client-side scanning if the v2 endpoint is unavailable
      return this.searchManual(namespace, searchText, options);
    }
  }

  private async searchManual(
    namespace: string,
    searchText: string,
    options: {
      type?: DocumentCategory;
      system?: boolean;
      generated?: boolean;
      maxResults?: number;
    } = {},
  ): Promise<SearchResult[]> {
    const {
      type,
      system = false,
      generated = false,
      maxResults = 100,
    } = options;

    const docs = await this.listDocuments(namespace, { type, generated });
    const results: SearchResult[] = [];
    const needle = searchText.toLowerCase();

    for (const doc of docs) {
      if (!system && doc.name.startsWith('%')) continue;
      if (results.length >= maxResults) break;

      try {
        const content = await this.getDocumentContent(namespace, doc.name);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            results.push({
              doc: doc.name,
              line: i + 1,
              text: lines[i].trim(),
            });
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        // Ignore documents we can't read
      }
    }

    return results;
  }

  // ============ CLASS INTROSPECTION (via %Dictionary SQL) ============

  async getClassInfo(
    namespace: string,
    className: string,
  ): Promise<Record<string, unknown>> {
    const queries = {
      classInfo: `
        SELECT Name, Super, Abstract, Final, Description, TimeCreated, TimeChanged
        FROM %Dictionary.ClassDefinition
        WHERE Name = ?
      `,
      properties: `
        SELECT Name, Type, Description, Required, Collection, Calculated
        FROM %Dictionary.PropertyDefinition
        WHERE parent = ?
        ORDER BY SequenceNumber
      `,
      methods: `
        SELECT Name, ReturnType, Description, ClassMethod, Abstract, Final, FormalSpec
        FROM %Dictionary.MethodDefinition
        WHERE parent = ?
        ORDER BY SequenceNumber
      `,
      parameters: `
        SELECT Name, Type, Default, Description
        FROM %Dictionary.ParameterDefinition
        WHERE parent = ?
        ORDER BY SequenceNumber
      `,
      indices: `
        SELECT Name, Properties, Type, "Unique", PrimaryKey
        FROM %Dictionary.IndexDefinition
        WHERE parent = ?
        ORDER BY SequenceNumber
      `,
    };

    const results: Record<string, unknown> = {};
    for (const [key, sql] of Object.entries(queries)) {
      try {
        // The Atelier query endpoint does not bind `?` placeholders, so we
        // substitute the class name via a safe single-quote escape.
        const escaped = className.replace(/'/g, "''");
        const bound = sql.replace(/\?/g, `'${escaped}'`);
        const result = await this.executeQuery(namespace, bound);
        results[key] = result.content;
      } catch {
        results[key] = [];
      }
    }
    return results;
  }
}
