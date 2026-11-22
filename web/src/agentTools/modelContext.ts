/**
 * The WebMCP surface the agent tools register against: the slice of
 * `document.modelContext` this app uses, the tool shape it registers, and the
 * one result shape every tool returns. Tests pass a fake ModelContextLike, so
 * nothing here may assume a real browser context.
 */

/** A JSON Schema fragment, as a tool's inputSchema nests them. */
export type JsonSchema = Record<string, unknown>;

/** A tool's input schema: always an object schema. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchema>;
  required?: string[];
}

/** The WebMCP tool annotations this app sets. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
}

/**
 * The MCP tool result shape. MCP-B bridges it to desktop clients as is, and
 * the native WebMCP API accepts any JSON value, so one shape serves both.
 */
export interface ToolResult {
  content: [{ type: 'text'; text: string }];
  isError?: true;
}

/** One tool as it is registered. */
export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  execute(input: unknown, context?: { signal?: AbortSignal }): Promise<ToolResult>;
}

/** The registration target: `document.modelContext` or a test fake. */
export interface ModelContextLike {
  registerTool(tool: AgentTool, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * The single result helper: the body as JSON text in the MCP content shape.
 * A user-fixable failure passes isError, and its body carries the user-worded
 * problem, so the agent can relay or correct it.
 */
export function toolResult(body: object, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(body) }] };
  if (isError) result.isError = true;
  return result;
}

/** A document that may or may not carry a WebMCP model context. */
export interface ModelContextHost {
  modelContext?: ModelContextLike;
}

/**
 * The page's model context: the native one when the browser provides it,
 * otherwise the @mcp-b/global polyfill, which installs `document.modelContext`
 * when its module is imported. The polyfill is only loaded when the native API
 * is missing, through a dynamic import so it stays in its own chunk. Throws
 * when the context is still missing afterwards (the polyfill declines to
 * install outside a secure context, for one).
 */
export async function loadModelContext(
  host: ModelContextHost,
  loadPolyfill: () => Promise<unknown>,
): Promise<ModelContextLike> {
  if (host.modelContext !== undefined) return host.modelContext;
  await loadPolyfill();
  const context = host.modelContext;
  if (context === undefined) {
    throw new Error(
      'The WebMCP polyfill loaded but did not install document.modelContext. The page may not be a secure context.',
    );
  }
  return context;
}
