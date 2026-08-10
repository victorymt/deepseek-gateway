import { test } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';

import {
  ChatCompletionsSseTransform,
  chatCompletionToResponses,
  chatCompletionToResponsesSse,
  normalizeChatCompletionsError,
  responsesRequestToChatCompletions,
} from '../chat-completions-adapter.mjs';

function parseEvents(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim())
    .filter(Boolean)
    .map(data => JSON.parse(data));
}

async function transformChunks(chunks, context) {
  const transform = new ChatCompletionsSseTransform(context);
  const output = [];
  transform.on('data', chunk => output.push(chunk));
  await new Promise((resolve, reject) => {
    Readable.from(chunks).pipe(transform).on('end', resolve).on('error', reject);
  });
  return Buffer.concat(output).toString('utf8');
}

test('Responses requests convert messages, tools, settings, and usage options', () => {
  const { payload, context } = responsesRequestToChatCompletions({
    model: 'provider-model',
    instructions: 'Follow the project rules.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: { ok: true } },
      { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' },
    ],
    tools: [
      { type: 'function', name: 'lookup', description: 'Lookup', parameters: null, strict: true },
      { type: 'custom', name: 'apply_patch', description: 'Apply a patch' },
    ],
    tool_choice: { type: 'function', name: 'lookup' },
    max_output_tokens: 123,
    reasoning: { effort: 'high' },
    text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true } },
    parallel_tool_calls: true,
    stream: true,
    stream_options: { include_obfuscation: false },
  });

  assert.equal(payload.model, 'provider-model');
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].content, 'inspect');
  assert.equal(payload.messages[2].tool_calls[0].function.name, 'lookup');
  assert.equal(payload.messages[2].reasoning_content, 'checking');
  assert.equal(payload.messages[3].role, 'tool');
  assert.equal(payload.messages[4].tool_calls[0].function.arguments, '{"input":"*** Begin Patch"}');
  assert.deepEqual(payload.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.equal(payload.tools[1].function.parameters.required[0], 'input');
  assert.match(payload.tools[1].function.description, /Original tool definition/);
  assert.deepEqual(payload.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(payload.max_tokens, 123);
  assert.equal(payload.reasoning_effort, 'high');
  assert.equal(payload.response_format.json_schema.name, 'result');
  assert.deepEqual(payload.stream_options, { include_obfuscation: false, include_usage: true });
  assert.equal(context.byChatName.get('apply_patch').kind, 'custom');
});

test('Responses request conversion rejects stateful and hosted features explicitly', () => {
  assert.throws(
    () => responsesRequestToChatCompletions({ model: 'x', previous_response_id: 'resp_old', input: 'x' }),
    /previous_response_id/,
  );
  assert.throws(
    () => responsesRequestToChatCompletions({ model: 'x', input: 'x', tools: [{ type: 'web_search' }] }),
    /web_search/,
  );
  assert.throws(
    () => responsesRequestToChatCompletions({
      model: 'x',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }],
    }),
    /input_file/,
  );
});

test('non-stream Chat response converts text, reasoning, custom tools, and usage', () => {
  const { context } = responsesRequestToChatCompletions({
    model: 'x',
    input: 'run',
    tools: [{ type: 'custom', name: 'apply_patch' }],
  });
  const result = chatCompletionToResponses({
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: 123,
    model: 'x',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Ready',
        reasoning_content: 'Need a change',
        tool_calls: [{
          id: 'call_patch',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"patch body"}' },
        }],
      },
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }, context);

  assert.equal(result.id, 'resp_abc');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output.map(item => item.type), ['reasoning', 'message', 'custom_tool_call']);
  assert.equal(result.output[2].input, 'patch body');
  assert.equal(result.output[2].call_id, 'call_patch');
  assert.equal(result.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(result.usage.total_tokens, 17);
});

test('fragmented Chat SSE converts to a complete Responses event stream', async () => {
  const { context } = responsesRequestToChatCompletions({
    model: 'x',
    input: 'run',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
  });
  const frames = [
    'data: {"id":"chatcmpl-stream","created":100,"model":"x","choices":[{"delta":{"reasoning_content":"check "}}]}\n\n',
    'data: {"id":"chatcmpl-stream","model":"x","choices":[{"delta":{"reasoning_content":"first"}}]}\n\n',
    'data: {"id":"chatcmpl-stream","model":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"id":"chatcmpl-stream","model":"x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"id":"chatcmpl-stream","model":"x","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const chunks = [
    Buffer.from(frames.slice(0, 37)),
    Buffer.from(frames.slice(37, 151)),
    Buffer.from(frames.slice(151)),
  ];
  const output = await transformChunks(chunks, context);
  const events = parseEvents(output);
  const types = events.map(event => event.type);

  assert.equal(types[0], 'response.created');
  assert.equal(types[1], 'response.in_progress');
  assert.ok(types.includes('response.reasoning_summary_text.delta'));
  assert.ok(types.includes('response.function_call_arguments.delta'));
  assert.ok(types.includes('response.function_call_arguments.done'));
  assert.equal(types.filter(type => type === 'response.completed').length, 1);
  assert.equal(events.at(-1).response.usage.total_tokens, 12);
  assert.equal(events.at(-1).response.output.at(-1).arguments, '{"q":"docs"}');
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
});

test('clean EOF synthesizes terminal events and empty truncation fails', async () => {
  const substantive = await transformChunks([
    'data: {"id":"chatcmpl-eof","model":"x","choices":[{"delta":{"content":"partial"}}]}\n\n',
  ]);
  const substantiveEvents = parseEvents(substantive);
  assert.equal(substantiveEvents.at(-1).type, 'response.completed');
  assert.equal(substantiveEvents.at(-1).response.status, 'incomplete');

  const empty = await transformChunks([
    'data: {"id":"chatcmpl-empty","model":"x","choices":[]}\n\n',
  ]);
  const emptyEvents = parseEvents(empty);
  assert.equal(emptyEvents.at(-1).type, 'response.failed');
  assert.equal(emptyEvents.at(-1).response.error.type, 'stream_truncated');
});

test('non-stream Chat responses can be emitted as Responses SSE', () => {
  const converted = chatCompletionToResponsesSse({
    id: 'chatcmpl-json',
    created: 100,
    model: 'x',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
  const events = parseEvents(converted.body);
  assert.ok(events.some(event => event.type === 'response.output_text.delta' && event.delta === 'hello'));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(converted.usage.total_tokens, 3);
});

test('Chat error payloads normalize to the Responses error envelope', () => {
  assert.deepEqual(normalizeChatCompletionsError({
    base_resp: { status_code: 1001, status_msg: 'quota exhausted' },
  }, 429), {
    error: {
      message: 'quota exhausted',
      type: 'upstream_error',
      code: 1001,
      param: null,
    },
  });
});
