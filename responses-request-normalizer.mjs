#!/usr/bin/env node
'use strict';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAgentMessageItem(item) {
  if (!isObject(item) || item.type !== 'agent_message') return item;
  const content = Array.isArray(item.content)
    ? item.content.map(part => (
      isObject(part)
      && part.type === 'encrypted_content'
      && typeof part.encrypted_content === 'string'
        ? { type: 'input_text', text: part.encrypted_content }
        : part
    ))
    : item.content;
  return {
    type: 'message',
    role: 'user',
    content,
    ...(item.id !== undefined ? { id: item.id } : {}),
  };
}

export function normalizeAgentMessagesForUpstream(payload) {
  if (!isObject(payload)) return payload;
  if (Array.isArray(payload.input)) {
    let changed = false;
    const input = payload.input.map(item => {
      const normalized = normalizeAgentMessageItem(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    return changed ? { ...payload, input } : payload;
  }
  const input = normalizeAgentMessageItem(payload.input);
  return input === payload.input ? payload : { ...payload, input };
}
