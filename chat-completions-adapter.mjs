#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import { normalizeAgentMessagesForUpstream } from './responses-request-normalizer.mjs';

export { normalizeAgentMessagesForUpstream } from './responses-request-normalizer.mjs';

const CUSTOM_TOOL_INPUT_FIELD = 'input';
const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CHAT_TOOL_NAME_MAX_LENGTH = 64;
const FILTERED_HOSTED_TOOL_TYPES = new Set([
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
]);
const PASSTHROUGH_FIELDS = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'metadata',
  'n',
  'parallel_tool_calls',
  'presence_penalty',
  'seed',
  'service_tier',
  'stop',
  'top_logprobs',
  'user',
];

export class ChatCompletionsAdapterError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ChatCompletionsAdapterError';
    this.statusCode = statusCode;
  }
}

function adapterError(message) {
  return new ChatCompletionsAdapterError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function chatToolName(name, namespace = '') {
  const raw = namespace ? `${namespace}__${name}` : String(name || '');
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  if (normalized.length <= CHAT_TOOL_NAME_MAX_LENGTH) return normalized;
  const suffix = `_${shortHash(raw)}`;
  return `${normalized.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function normalizeParameters(value) {
  if (isObject(value)) return value;
  return { type: 'object', properties: {} };
}

function createToolContext(tools) {
  const context = { byChatName: new Map(), chatTools: [] };

  const add = (tool, namespace = '') => {
    if (typeof tool === 'string') {
      add({ type: 'custom', name: tool });
      return;
    }
    if (!isObject(tool)) throw adapterError('tools must contain objects');
    const type = String(tool.type || 'function');
    if (FILTERED_HOSTED_TOOL_TYPES.has(type)) return;
    if (type === 'namespace') {
      const children = tool.tools ?? tool.children;
      if (!Array.isArray(children)) throw adapterError(`namespace tool ${tool.name || ''} must contain tools`);
      for (const child of children) add(child, String(tool.name || ''));
      return;
    }
    if (type === 'tool_search') {
      const chatName = TOOL_SEARCH_PROXY_NAME;
      if (context.byChatName.has(chatName)) return;
      context.byChatName.set(chatName, { kind: 'tool_search', name: chatName, namespace: '' });
      context.chatTools.push({
        type: 'function',
        function: {
          name: chatName,
          description: 'Search and load tools available to the client.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'integer' },
            },
            required: ['query'],
          },
        },
      });
      return;
    }
    if (type === 'custom') {
      const name = String(tool.name || '').trim();
      if (!name) throw adapterError('custom tool name is required');
      const chatName = chatToolName(name);
      if (context.byChatName.has(chatName)) throw adapterError(`duplicate Chat tool name: ${chatName}`);
      const metadata = { ...tool };
      delete metadata.description;
      const description = [
        String(tool.description || 'Execute the named custom tool with the exact input string.'),
        `Original tool definition:\n${JSON.stringify(metadata)}`,
      ].join('\n\n');
      context.byChatName.set(chatName, { kind: 'custom', name, namespace: '' });
      context.chatTools.push({
        type: 'function',
        function: {
          name: chatName,
          description,
          parameters: {
            type: 'object',
            properties: {
              [CUSTOM_TOOL_INPUT_FIELD]: {
                type: 'string',
                description: 'Raw string input for the original custom tool.',
              },
            },
            required: [CUSTOM_TOOL_INPUT_FIELD],
          },
        },
      });
      return;
    }
    if (type !== 'function') {
      throw adapterError(`Responses tool type ${type} is not supported by Chat Completions upstreams`);
    }

    const source = isObject(tool.function) ? tool.function : tool;
    const name = String(source.name || '').trim();
    if (!name) throw adapterError('function tool name is required');
    const chatName = chatToolName(name, namespace);
    if (context.byChatName.has(chatName)) throw adapterError(`duplicate Chat tool name: ${chatName}`);
    const fn = {
      name: chatName,
      description: String(source.description || ''),
      parameters: normalizeParameters(source.parameters),
    };
    if (source.strict !== undefined && source.strict !== null) fn.strict = source.strict === true;
    context.byChatName.set(chatName, {
      kind: namespace ? 'namespace' : 'function',
      name,
      namespace,
    });
    context.chatTools.push({ type: 'function', function: fn });
  };

  for (const tool of tools || []) add(tool);
  return context;
}

function textFromParts(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => typeof part === 'string' ? part : String(part?.text || '')).filter(Boolean).join('\n\n');
}

function responseContentToChat(content, role) {
  if (content === null || content === undefined || typeof content === 'string') return content ?? null;
  if (!Array.isArray(content)) throw adapterError('message content must be a string or array');
  const parts = [];
  let hasMedia = false;
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'text', text: part });
      continue;
    }
    if (!isObject(part)) throw adapterError('message content parts must be objects');
    const type = String(part.type || '');
    if (['input_text', 'output_text', 'text'].includes(type)) {
      const text = String(part.text || '');
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'refusal') {
      const text = String(part.refusal || '');
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'input_image') {
      const source = part.image_url;
      const imageUrl = isObject(source)
        ? { ...source }
        : { url: String(source || '') };
      if (!imageUrl.url) throw adapterError('input_image.image_url is required');
      if (part.detail && !imageUrl.detail) imageUrl.detail = part.detail;
      parts.push({ type: 'image_url', image_url: imageUrl });
      hasMedia = true;
      continue;
    }
    if (type === 'input_audio' && isObject(part.input_audio)) {
      parts.push({ type: 'input_audio', input_audio: part.input_audio });
      hasMedia = true;
      continue;
    }
    if (type === 'input_file') {
      throw adapterError('input_file is not supported by Chat Completions upstreams');
    }
    throw adapterError(`Responses content type ${type || '<missing>'} is not supported by Chat Completions upstreams`);
  }
  if (!hasMedia) return parts.map(part => part.text).join('');
  if (role !== 'user' && hasMedia) throw adapterError(`media content is not supported for role ${role}`);
  return parts;
}

function reasoningText(item) {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof item?.[field] === 'string' && item[field].trim()) return item[field];
  }
  for (const field of ['summary', 'content']) {
    if (!Array.isArray(item?.[field])) continue;
    const text = item[field]
      .map(part => typeof part === 'string' ? part : part?.text)
      .filter(value => typeof value === 'string' && value)
      .join('\n\n');
    if (text) return text;
  }
  return '';
}

function canonicalArguments(value) {
  if (typeof value === 'string') {
    if (!value.trim()) return '{}';
    try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
  }
  if (value === undefined || value === null) return '{}';
  return JSON.stringify(value);
}

function customArguments(input) {
  return JSON.stringify({ [CUSTOM_TOOL_INPUT_FIELD]: String(input || '') });
}

function responseCallToChat(item, context) {
  const type = String(item.type || 'function_call');
  const originalName = type === 'tool_search_call' ? TOOL_SEARCH_PROXY_NAME : String(item.name || '').trim();
  const namespace = String(item.namespace || '');
  const chatName = type === 'tool_search_call' ? TOOL_SEARCH_PROXY_NAME : chatToolName(originalName, namespace);
  const callId = String(item.call_id || item.id || `call_${crypto.randomUUID()}`);
  let args;
  if (type === 'custom_tool_call') args = customArguments(item.input);
  else if (type === 'tool_search_call') args = canonicalArguments(item.arguments);
  else args = canonicalArguments(item.arguments);
  if (!context.byChatName.has(chatName) && originalName) {
    context.byChatName.set(chatName, {
      kind: type === 'custom_tool_call' ? 'custom' : type === 'tool_search_call' ? 'tool_search' : namespace ? 'namespace' : 'function',
      name: originalName,
      namespace,
    });
  }
  return { id: callId, type: 'function', function: { name: chatName, arguments: args } };
}

function toolOutputText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

function collapseSystemMessages(messages) {
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message.role === 'system' && typeof message.content === 'string') {
      if (message.content.trim()) system.push(message.content);
    } else {
      rest.push(message);
    }
  }
  return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...rest] : rest;
}

function appendResponsesInput(input, messages, context) {
  const items = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input === undefined ? [] : [input];
  const pendingCalls = [];
  let pendingReasoning = '';
  let lastAssistantIndex = -1;

  const attachReasoning = message => {
    if (!pendingReasoning.trim()) return;
    message.reasoning_content = pendingReasoning;
    pendingReasoning = '';
  };
  const attachReasoningBackward = () => {
    if (!pendingReasoning.trim()) return;
    const previous = messages[lastAssistantIndex];
    if (previous?.role === 'assistant') {
      previous.reasoning_content = previous.reasoning_content
        ? `${previous.reasoning_content}\n\n${pendingReasoning}`
        : pendingReasoning;
    }
    pendingReasoning = '';
  };
  const pushMessage = message => {
    if (message.role === 'assistant') {
      attachReasoning(message);
      lastAssistantIndex = messages.length;
    } else if (message.role !== 'tool') {
      attachReasoningBackward();
      lastAssistantIndex = -1;
    }
    messages.push(message);
  };
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    const message = { role: 'assistant', content: null, tool_calls: pendingCalls.splice(0) };
    attachReasoning(message);
    if (!message.reasoning_content) message.reasoning_content = 'tool call';
    lastAssistantIndex = messages.length;
    messages.push(message);
  };

  for (const item of items) {
    if (typeof item === 'string') {
      flushCalls();
      pushMessage({ role: 'user', content: item });
      continue;
    }
    if (!isObject(item)) throw adapterError('Responses input items must be strings or objects');
    const type = String(item.type || 'message');
    if (type === 'item_reference') throw adapterError('previous response item references are not supported by Chat Completions upstreams');
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(type)) {
      const reasoning = reasoningText(item);
      if (reasoning && !pendingReasoning.includes(reasoning)) pendingReasoning += `${pendingReasoning ? '\n\n' : ''}${reasoning}`;
      pendingCalls.push(responseCallToChat(item, context));
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(type)) {
      flushCalls();
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || item.id || ''),
        content: toolOutputText(item.output),
      });
      continue;
    }
    if (type === 'reasoning') {
      const text = reasoningText(item);
      if (text) pendingReasoning += `${pendingReasoning ? '\n\n' : ''}${text}`;
      continue;
    }
    if (['input_text', 'input_image', 'input_audio', 'input_file'].includes(type)) {
      flushCalls();
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user';
      pushMessage({ role, content: responseContentToChat([item], role) });
      continue;
    }
    if (type !== 'message' && !item.role && item.content === undefined) {
      throw adapterError(`Responses input item type ${type} is not supported by Chat Completions upstreams`);
    }
    flushCalls();
    const sourceRole = String(item.role || 'user');
    const role = ['system', 'developer'].includes(sourceRole) ? 'system' : sourceRole === 'assistant' ? 'assistant' : sourceRole === 'tool' ? 'tool' : 'user';
    const message = { role, content: responseContentToChat(item.content, role) };
    if (role === 'tool') message.tool_call_id = String(item.tool_call_id || item.call_id || '');
    const embeddedReasoning = reasoningText(item);
    if (embeddedReasoning) message.reasoning_content = embeddedReasoning;
    pushMessage(message);
  }
  flushCalls();
  attachReasoningBackward();
}

function responseFormatFromText(text) {
  const format = text?.format;
  if (!isObject(format) || !format.type || format.type === 'text') return null;
  if (format.type === 'json_schema') {
    const { type: _type, ...jsonSchema } = format;
    return { type: 'json_schema', json_schema: jsonSchema };
  }
  if (format.type === 'json_object') return { type: 'json_object' };
  throw adapterError(`Responses text format ${format.type} is not supported by Chat Completions upstreams`);
}

function chatToolChoice(choice, context) {
  if (typeof choice === 'string' || choice === null) return choice;
  if (!isObject(choice)) throw adapterError('tool_choice must be a string or object');
  if (FILTERED_HOSTED_TOOL_TYPES.has(String(choice.type || ''))) return undefined;
  if (choice.type === 'allowed_tools') throw adapterError('allowed_tools tool_choice is not supported by Chat Completions upstreams');
  const name = choice.type === 'tool_search' ? TOOL_SEARCH_PROXY_NAME : String(choice.name || choice.function?.name || '');
  const namespace = String(choice.namespace || '');
  const chatName = choice.type === 'tool_search' ? TOOL_SEARCH_PROXY_NAME : chatToolName(name, namespace);
  if (!context.byChatName.has(chatName)) throw adapterError(`tool_choice references unknown tool ${name || '<missing>'}`);
  return { type: 'function', function: { name: chatName } };
}

export function responsesRequestToChatCompletions(payload) {
  if (!isObject(payload)) throw adapterError('Responses request body must be a JSON object');
  payload = normalizeAgentMessagesForUpstream(payload);
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) throw adapterError('tools must be an array');
  if (payload.previous_response_id) throw adapterError('previous_response_id is not supported by Chat Completions upstreams');
  if (payload.background === true) throw adapterError('background responses are not supported by Chat Completions upstreams');
  if (payload.conversation) throw adapterError('conversation state is not supported by Chat Completions upstreams');

  const context = createToolContext(Array.isArray(payload.tools) ? payload.tools : []);
  const messages = [];
  const instructions = textFromParts(payload.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  appendResponsesInput(payload.input, messages, context);

  const result = {
    model: payload.model,
    messages: collapseSystemMessages(messages),
  };
  if (!result.model) delete result.model;
  if (payload.max_output_tokens !== undefined) result.max_tokens = payload.max_output_tokens;
  if (payload.max_tokens !== undefined) result.max_tokens = payload.max_tokens;
  if (payload.max_completion_tokens !== undefined) result.max_completion_tokens = payload.max_completion_tokens;
  if (payload.reasoning?.effort !== undefined) result.reasoning_effort = payload.reasoning.effort;
  for (const field of ['temperature', 'top_p', 'stream']) {
    if (payload[field] !== undefined) result[field] = payload[field];
  }
  for (const field of PASSTHROUGH_FIELDS) {
    if (payload[field] !== undefined) result[field] = payload[field];
  }
  const responseFormat = responseFormatFromText(payload.text);
  if (payload.response_format !== undefined) result.response_format = payload.response_format;
  if (responseFormat) result.response_format = responseFormat;
  const toolChoice = payload.tool_choice !== undefined
    ? chatToolChoice(payload.tool_choice, context)
    : undefined;
  if (context.chatTools.length) {
    result.tools = context.chatTools;
    if (toolChoice !== undefined) result.tool_choice = toolChoice;
  } else {
    delete result.parallel_tool_calls;
  }
  if (result.stream) {
    result.stream_options = {
      ...(isObject(payload.stream_options) ? payload.stream_options : {}),
      include_usage: true,
    };
  }
  return { payload: result, context };
}

function responseIdFromChat(id) {
  const value = String(id || '');
  if (value.startsWith('resp_')) return value;
  if (value.startsWith('chatcmpl-')) return `resp_${value.slice('chatcmpl-'.length)}`;
  return value ? `resp_${value.replace(/[^a-zA-Z0-9_-]/g, '_')}` : `resp_gateway_${crypto.randomUUID()}`;
}

export function chatUsageToResponsesUsage(usage) {
  const source = isObject(usage) ? usage : {};
  const inputTokens = Number(source.prompt_tokens ?? source.input_tokens ?? 0) || 0;
  const outputTokens = Number(source.completion_tokens ?? source.output_tokens ?? 0) || 0;
  const totalTokens = Number(source.total_tokens ?? inputTokens + outputTokens) || 0;
  const cachedTokens = Number(source.prompt_tokens_details?.cached_tokens ?? source.input_tokens_details?.cached_tokens ?? 0) || 0;
  const cacheWriteTokens = Number(source.prompt_tokens_details?.cache_write_tokens ?? source.input_tokens_details?.cache_write_tokens ?? source.cache_creation_input_tokens ?? 0) || 0;
  const details = isObject(source.completion_tokens_details)
    ? { ...source.completion_tokens_details }
    : {};
  if (details.reasoning_tokens === undefined) details.reasoning_tokens = 0;
  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    output_tokens_details: details,
  };
  if (cachedTokens || cacheWriteTokens) {
    result.input_tokens_details = { cached_tokens: cachedTokens };
    if (cacheWriteTokens) result.input_tokens_details.cache_write_tokens = cacheWriteTokens;
  }
  return result;
}

function splitThinkBlock(text) {
  const match = /^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/i.exec(text);
  return match ? { reasoning: match[1], answer: match[2] } : null;
}

function messageTextAndReasoning(message) {
  let reasoning = reasoningText(message);
  let text = '';
  if (typeof message?.content === 'string') text = message.content;
  else if (Array.isArray(message?.content)) {
    text = message.content
      .map(part => ['text', 'output_text'].includes(part?.type) ? String(part.text || '') : part?.type === 'refusal' ? String(part.refusal || '') : '')
      .join('');
  }
  const think = splitThinkBlock(text);
  if (think) {
    reasoning ||= think.reasoning;
    text = think.answer;
  }
  return { text, reasoning };
}

function customInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText);
    return isObject(parsed) && typeof parsed[CUSTOM_TOOL_INPUT_FIELD] === 'string'
      ? parsed[CUSTOM_TOOL_INPUT_FIELD]
      : argumentsText;
  } catch {
    return argumentsText;
  }
}

function responseToolItem(call, index, context, status = 'completed', reasoning = '', canonicalize = true) {
  const callId = String(call?.id || `call_${index}`);
  const chatName = String(call?.function?.name || call?.name || '');
  if (!chatName) return null;
  const spec = context?.byChatName?.get(chatName);
  const rawArguments = call?.function?.arguments ?? call?.arguments ?? '';
  const argumentsText = canonicalize ? canonicalArguments(rawArguments) : String(rawArguments);
  let item;
  if (spec?.kind === 'custom') {
    item = {
      id: `ctc_${callId}`,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name: spec.name,
      input: customInput(argumentsText),
    };
  } else if (spec?.kind === 'tool_search') {
    let args = {};
    try { args = JSON.parse(argumentsText); } catch { args = { query: argumentsText }; }
    item = { type: 'tool_search_call', status, call_id: callId, execution: 'client', arguments: args };
  } else {
    item = {
      id: `fc_${callId}`,
      type: 'function_call',
      status,
      call_id: callId,
      name: spec?.name || chatName,
      arguments: argumentsText,
    };
    if (spec?.namespace) item.namespace = spec.namespace;
  }
  if (reasoning) item.reasoning_content = reasoning;
  return item;
}

function responseStatus(finishReason) {
  const reason = String(finishReason || '').trim();
  if (!reason) return 'incomplete';
  return ['length', 'max_tokens', 'content_filter'].includes(reason) ? 'incomplete' : 'completed';
}

function baseResponse({ id, createdAt, model, status, output, usage, finishReason, error = null }) {
  const response = {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error,
    incomplete_details: null,
    model,
    output,
    usage,
  };
  if (status === 'incomplete') {
    response.incomplete_details = {
      reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens',
    };
  }
  return response;
}

export function chatCompletionToResponses(payload, context = createToolContext([])) {
  if (!isObject(payload)) throw new ChatCompletionsAdapterError('upstream Chat Completions response must be a JSON object', 502);
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new ChatCompletionsAdapterError('upstream Chat Completions response has no message choice', 502);
  }
  const id = responseIdFromChat(payload.id);
  const createdAt = Number(payload.created) || Math.floor(Date.now() / 1000);
  const model = String(payload.model || '');
  const finishReason = choice.finish_reason;
  let status = responseStatus(finishReason);
  const { text, reasoning } = messageTextAndReasoning(choice.message);
  const output = [];
  if (reasoning) {
    output.push({
      id: `rs_${id}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  if (text) {
    output.push({
      id: `${id}_msg`,
      type: 'message',
      status,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  for (let index = 0; index < toolCalls.length; index++) {
    const item = responseToolItem(toolCalls[index], index, context, status, reasoning);
    if (item) output.push(item);
  }
  if (!finishReason && !output.length) status = 'failed';
  const normalizedFinishReason = !finishReason && status === 'incomplete' ? 'length' : finishReason;
  return baseResponse({
    id,
    createdAt,
    model,
    status,
    output,
    usage: chatUsageToResponsesUsage(payload.usage),
    finishReason: normalizedFinishReason,
    error: status === 'failed'
      ? { message: 'Upstream Chat Completions response ended before sending finish_reason', type: 'response_truncated' }
      : null,
  });
}

function extractError(payload, fallbackStatus = 502) {
  const error = isObject(payload?.error) ? payload.error : payload;
  const message = String(
    error?.message
    ?? error?.detail
    ?? payload?.base_resp?.status_msg
    ?? payload?.message
    ?? `upstream Chat Completions request failed with HTTP ${fallbackStatus}`,
  );
  return {
    message,
    type: String(error?.type ?? error?.error_type ?? 'upstream_error'),
    code: error?.code ?? payload?.base_resp?.status_code ?? null,
    param: error?.param ?? null,
  };
}

export function normalizeChatCompletionsError(payload, statusCode = 502) {
  return { error: extractError(isObject(payload) ? payload : {}, statusCode) };
}

function sseFrame(type, value, sequenceNumber) {
  const data = { ...value, type, sequence_number: sequenceNumber };
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

class ChatToResponsesState {
  constructor(context) {
    this.context = context || createToolContext([]);
    this.responseStarted = false;
    this.completed = false;
    this.terminal = '';
    this.responseId = `resp_gateway_${crypto.randomUUID()}`;
    this.model = '';
    this.createdAt = Math.floor(Date.now() / 1000);
    this.sequence = 0;
    this.nextOutputIndex = 0;
    this.text = { added: false, done: false, outputIndex: -1, itemId: '', text: '' };
    this.reasoning = { added: false, done: false, outputIndex: -1, itemId: '', text: '' };
    this.inlineThink = { mode: 'detecting', buffer: '' };
    this.tools = new Map();
    this.outputItems = [];
    this.latestUsage = chatUsageToResponsesUsage(null);
    this.finishReason = null;
    this.finalResponse = null;
  }

  event(type, value) {
    return sseFrame(type, value, this.sequence++);
  }

  response(status, output = this.completedOutputItems(), error = null) {
    return baseResponse({
      id: this.responseId,
      createdAt: this.createdAt,
      model: this.model,
      status,
      output,
      usage: this.latestUsage,
      finishReason: this.finishReason,
      error,
    });
  }

  ensureStarted() {
    if (this.responseStarted) return [];
    this.responseStarted = true;
    const response = this.response('in_progress', []);
    return [
      this.event('response.created', { response }),
      this.event('response.in_progress', { response }),
    ];
  }

  allocateOutput() {
    return this.nextOutputIndex++;
  }

  pushReasoning(delta) {
    if (!delta) return [];
    const events = [];
    if (!this.reasoning.added) {
      this.reasoning.added = true;
      this.reasoning.outputIndex = this.allocateOutput();
      this.reasoning.itemId = `rs_${this.responseId}`;
      events.push(this.event('response.output_item.added', {
        output_index: this.reasoning.outputIndex,
        item: { id: this.reasoning.itemId, type: 'reasoning', status: 'in_progress', summary: [] },
      }));
      events.push(this.event('response.reasoning_summary_part.added', {
        item_id: this.reasoning.itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    this.reasoning.text += delta;
    events.push(this.event('response.reasoning_summary_text.delta', {
      item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      delta,
    }));
    return events;
  }

  finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return [];
    this.reasoning.done = true;
    const item = {
      id: this.reasoning.itemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: this.reasoning.text }],
    };
    this.outputItems.push([this.reasoning.outputIndex, item]);
    return [
      this.event('response.reasoning_summary_text.done', {
        item_id: this.reasoning.itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        text: this.reasoning.text,
      }),
      this.event('response.reasoning_summary_part.done', {
        item_id: this.reasoning.itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: this.reasoning.text },
      }),
      this.event('response.output_item.done', { output_index: this.reasoning.outputIndex, item }),
    ];
  }

  pushText(delta) {
    if (!delta) return [];
    const events = [];
    if (!this.text.added) {
      this.text.added = true;
      this.text.outputIndex = this.allocateOutput();
      this.text.itemId = `${this.responseId}_msg`;
      events.push(this.event('response.output_item.added', {
        output_index: this.text.outputIndex,
        item: { id: this.text.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      }));
      events.push(this.event('response.content_part.added', {
        item_id: this.text.itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    }
    this.text.text += delta;
    events.push(this.event('response.output_text.delta', {
      item_id: this.text.itemId,
      output_index: this.text.outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    }));
    return events;
  }

  finalizeText(status = 'completed') {
    if (!this.text.added || this.text.done) return [];
    this.text.done = true;
    const part = { type: 'output_text', text: this.text.text, annotations: [] };
    const item = {
      id: this.text.itemId,
      type: 'message',
      status,
      role: 'assistant',
      content: [part],
    };
    this.outputItems.push([this.text.outputIndex, item]);
    return [
      this.event('response.output_text.done', {
        item_id: this.text.itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        text: this.text.text,
        logprobs: [],
      }),
      this.event('response.content_part.done', {
        item_id: this.text.itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        part,
      }),
      this.event('response.output_item.done', { output_index: this.text.outputIndex, item }),
    ];
  }

  handleContent(delta) {
    if (this.inlineThink.mode === 'text') return [...this.finalizeReasoning(), ...this.pushText(delta)];
    this.inlineThink.buffer += delta;
    const trimmed = this.inlineThink.buffer.trimStart();
    if (this.inlineThink.mode === 'detecting') {
      if ('<think>'.startsWith(trimmed)) return [];
      if (!trimmed.startsWith('<think>')) {
        this.inlineThink.mode = 'text';
        const text = this.inlineThink.buffer;
        this.inlineThink.buffer = '';
        return [...this.finalizeReasoning(), ...this.pushText(text)];
      }
      this.inlineThink.mode = 'reasoning';
    }
    const think = splitThinkBlock(this.inlineThink.buffer);
    if (!think) return [];
    this.inlineThink.mode = 'text';
    this.inlineThink.buffer = '';
    return [
      ...this.pushReasoning(think.reasoning),
      ...this.finalizeReasoning(),
      ...this.pushText(think.answer),
    ];
  }

  flushInlineThink() {
    if (!this.inlineThink.buffer) return [];
    const buffered = this.inlineThink.buffer;
    this.inlineThink.buffer = '';
    if (this.inlineThink.mode === 'reasoning') {
      this.inlineThink.mode = 'text';
      return [...this.pushReasoning(buffered.replace(/^\s*<think>/i, '')), ...this.finalizeReasoning()];
    }
    this.inlineThink.mode = 'text';
    return [...this.finalizeReasoning(), ...this.pushText(buffered)];
  }

  pushToolDelta(call, fallbackIndex) {
    const index = Number(call?.index ?? fallbackIndex) || 0;
    let state = this.tools.get(index);
    if (!state) {
      state = { index, outputIndex: -1, added: false, done: false, callId: '', name: '', arguments: '', reasoning: '' };
      this.tools.set(index, state);
    }
    if (call?.id) state.callId = String(call.id);
    if (call?.function?.name || call?.name) state.name = String(call.function?.name || call.name);
    const delta = String(call?.function?.arguments ?? call?.arguments ?? '');
    if (delta) state.arguments += delta;
    if (!state.reasoning && this.reasoning.text) state.reasoning = this.reasoning.text;

    const events = [];
    const wasAdded = state.added;
    if (!state.added && state.name) {
      if (!state.callId) state.callId = `call_${index}`;
      state.added = true;
      state.outputIndex = this.allocateOutput();
      const item = responseToolItem({ id: state.callId, function: { name: state.name, arguments: '' } }, index, this.context, 'in_progress', state.reasoning, false);
      if (item) events.push(this.event('response.output_item.added', { output_index: state.outputIndex, item }));
    }
    const spec = this.context.byChatName.get(state.name);
    if (state.added && delta && spec?.kind !== 'custom') {
      events.push(this.event('response.function_call_arguments.delta', {
        item_id: spec?.kind === 'custom' ? `ctc_${state.callId}` : `fc_${state.callId}`,
        output_index: state.outputIndex,
        delta: wasAdded ? delta : state.arguments,
      }));
    }
    return events;
  }

  finalizeTools(status = 'completed') {
    const events = [];
    for (const [index, state] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (state.done || !state.name) continue;
      if (!state.callId) state.callId = `call_${index}`;
      if (!state.added) {
        state.added = true;
        state.outputIndex = this.allocateOutput();
        const added = responseToolItem({ id: state.callId, function: { name: state.name, arguments: '' } }, index, this.context, 'in_progress', state.reasoning, false);
        if (added) events.push(this.event('response.output_item.added', { output_index: state.outputIndex, item: added }));
      }
      const call = { id: state.callId, function: { name: state.name, arguments: state.arguments } };
      const item = responseToolItem(call, index, this.context, status, state.reasoning);
      if (!item) continue;
      const spec = this.context.byChatName.get(state.name);
      if (spec?.kind === 'custom') {
        if (item.input) events.push(this.event('response.custom_tool_call_input.delta', {
          item_id: item.id,
          output_index: state.outputIndex,
          delta: item.input,
        }));
        events.push(this.event('response.custom_tool_call_input.done', {
          item_id: item.id,
          output_index: state.outputIndex,
          input: item.input,
        }));
      } else {
        events.push(this.event('response.function_call_arguments.done', {
          item_id: item.id || `fc_${state.callId}`,
          output_index: state.outputIndex,
          arguments: canonicalArguments(state.arguments),
          name: item.name,
        }));
      }
      events.push(this.event('response.output_item.done', { output_index: state.outputIndex, item }));
      this.outputItems.push([state.outputIndex, item]);
      state.done = true;
    }
    return events;
  }

  handleChatChunk(chunk) {
    if (this.completed) return [];
    if (chunk?.id) this.responseId = responseIdFromChat(chunk.id);
    if (chunk?.model) this.model = String(chunk.model);
    if (chunk?.created) this.createdAt = Number(chunk.created) || this.createdAt;
    const events = this.ensureStarted();
    if (chunk?.usage) this.latestUsage = chatUsageToResponsesUsage(chunk.usage);
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
    if (!choice) return events;
    const delta = choice.delta || choice.message || {};
    const reasoning = reasoningText(delta);
    if (reasoning) events.push(...this.pushReasoning(reasoning));
    if (typeof delta.content === 'string' && delta.content) events.push(...this.handleContent(delta.content));
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      events.push(...this.flushInlineThink(), ...this.finalizeReasoning());
      delta.tool_calls.forEach((call, index) => events.push(...this.pushToolDelta(call, index)));
    }
    if (choice.finish_reason) this.finishReason = String(choice.finish_reason);
    return events;
  }

  completedOutputItems() {
    return [...this.outputItems].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  }

  hasSubstantiveOutput() {
    return Boolean(
      this.text.text.trim()
      || this.reasoning.text.trim()
      || this.inlineThink.buffer.trim()
      || this.outputItems.length
      || [...this.tools.values()].some(tool => tool.name || tool.arguments || tool.callId),
    );
  }

  finalize() {
    if (this.completed) return [];
    const status = responseStatus(this.finishReason);
    const events = [
      ...this.ensureStarted(),
      ...this.flushInlineThink(),
      ...this.finalizeReasoning(),
      ...this.finalizeText(status),
      ...this.finalizeTools(status),
    ];
    const response = this.response(status);
    this.finalResponse = response;
    events.push(this.event(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response }));
    this.completed = true;
    this.terminal = status;
    return events;
  }

  endOfStream() {
    if (this.completed) return [];
    if (this.finishReason) return this.finalize();
    if (this.hasSubstantiveOutput()) {
      this.finishReason = 'length';
      return this.finalize();
    }
    return [this.fail('Upstream Chat Completions stream ended before sending finish_reason', 'stream_truncated')];
  }

  fail(message, type = 'stream_error') {
    if (this.completed) return '';
    const error = { message: String(message), type };
    const events = [
      ...this.ensureStarted(),
      ...this.flushInlineThink(),
      ...this.finalizeReasoning(),
      ...this.finalizeText('incomplete'),
      ...this.finalizeTools('incomplete'),
    ];
    const response = this.response('failed', this.completedOutputItems(), error);
    this.finalResponse = response;
    this.completed = true;
    this.terminal = 'failed';
    events.push(this.event('response.failed', { response }));
    return events.join('');
  }
}

function takeSseBlock(holder) {
  const match = /\r?\n\r?\n/.exec(holder.buffer);
  if (!match) return null;
  const block = holder.buffer.slice(0, match.index);
  holder.buffer = holder.buffer.slice(match.index + match[0].length);
  return block;
}

function parseSseBlock(block) {
  let event = '';
  const data = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    let value = separator < 0 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return { event, data: data.join('\n') };
}

export class ChatCompletionsSseTransform extends Transform {
  constructor(context, { onUsage, onTerminal } = {}) {
    super();
    this.decoder = new StringDecoder('utf8');
    this.holder = { buffer: '' };
    this.state = new ChatToResponsesState(context);
    this.onUsage = onUsage;
    this.onTerminal = onTerminal;
    this.terminalNotified = false;
  }

  pushEvents(events) {
    for (const event of events) if (event) this.push(event);
  }

  notifyTerminal() {
    if (this.terminalNotified || !this.state.terminal) return;
    this.terminalNotified = true;
    this.onUsage?.(this.state.latestUsage);
    this.onTerminal?.({ status: this.state.terminal, usage: this.state.latestUsage });
  }

  processBlock(block) {
    if (!block.trim() || this.state.completed) return;
    const { event, data } = parseSseBlock(block);
    if (!data) return;
    if (data.trim() === '[DONE]') {
      this.pushEvents(this.state.endOfStream());
      this.notifyTerminal();
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      if (event === 'ping' || event === 'keepalive') return;
      const failed = this.state.fail('Upstream Chat Completions stream sent invalid JSON', 'invalid_sse_data');
      if (failed) this.push(failed);
      this.notifyTerminal();
      return;
    }
    if (event === 'error' || chunk?.error) {
      const error = extractError(chunk);
      const failed = this.state.fail(error.message, error.type);
      if (failed) this.push(failed);
      this.notifyTerminal();
      return;
    }
    this.pushEvents(this.state.handleChatChunk(chunk));
  }

  processAvailableBlocks() {
    for (;;) {
      const block = takeSseBlock(this.holder);
      if (block === null) break;
      this.processBlock(block);
    }
  }

  fail(message, type = 'stream_error') {
    const event = this.state.fail(message, type);
    if (event) this.push(event);
    this.notifyTerminal();
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.holder.buffer += this.decoder.write(chunk);
      this.processAvailableBlocks();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.holder.buffer += this.decoder.end();
      this.processAvailableBlocks();
      if (this.holder.buffer.trim()) this.processBlock(this.holder.buffer);
      this.holder.buffer = '';
      this.pushEvents(this.state.endOfStream());
      this.notifyTerminal();
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

export function chatCompletionsSseToResponses(text, context = createToolContext([])) {
  const state = new ChatToResponsesState(context);
  const holder = { buffer: String(text || '') };
  const process = block => {
    if (!block.trim() || state.completed) return;
    const { event, data } = parseSseBlock(block);
    if (!data) return;
    if (data.trim() === '[DONE]') {
      state.endOfStream();
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      if (event === 'ping' || event === 'keepalive') return;
      throw new ChatCompletionsAdapterError('upstream Chat Completions SSE sent invalid JSON', 502);
    }
    if (event === 'error' || chunk?.error) {
      const error = extractError(chunk);
      throw new ChatCompletionsAdapterError(error.message, 502);
    }
    state.handleChatChunk(chunk);
  };
  for (;;) {
    const block = takeSseBlock(holder);
    if (block === null) break;
    process(block);
  }
  if (holder.buffer.trim()) process(holder.buffer);
  if (!state.completed) state.endOfStream();
  if (state.terminal === 'failed' || !state.finalResponse) {
    throw new ChatCompletionsAdapterError(
      state.finalResponse?.error?.message || 'upstream Chat Completions SSE was incomplete',
      502,
    );
  }
  return { response: state.finalResponse, usage: state.latestUsage };
}

export function chatCompletionToResponsesSse(payload, context = createToolContext([])) {
  if (!isObject(payload)) throw new ChatCompletionsAdapterError('upstream Chat Completions response must be a JSON object', 502);
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new ChatCompletionsAdapterError('upstream Chat Completions response has no message choice', 502);
  }
  const state = new ChatToResponsesState(context);
  const chunk = {
    id: payload.id,
    created: payload.created,
    model: payload.model,
    usage: payload.usage,
    choices: [{ delta: choice.message, finish_reason: choice.finish_reason }],
  };
  return {
    body: [...state.handleChatChunk(chunk), ...state.endOfStream()].join(''),
    usage: state.latestUsage,
  };
}
