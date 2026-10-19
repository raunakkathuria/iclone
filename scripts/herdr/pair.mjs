#!/usr/bin/env node
// Herdr plugin entry: gives a workspace a builder-minion pane and a reviewer-minion pane, each
// with a tool.
// Herdr runs it on workspace.created (new workspaces) and workspace.focused (workspaces made
// before the plugin, or by a path that sends no created event). See herdr-plugin.toml.
import { ensureLayout, log, notify } from './lib/herdr.mjs';

function workspaceId() {
  try {
    const { data } = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}');
    return data?.workspace?.workspace_id ?? data?.workspace_id ?? process.env.HERDR_WORKSPACE_ID;
  } catch { return process.env.HERDR_WORKSPACE_ID; }
}

const workspace = workspaceId();
if (workspace) {
  ensureLayout(workspace).catch((e) => {
    log(`layout ${workspace}: error: ${e.stack || e.message}`);
    notify('Minion panes', `Could not set up workspace ${workspace}: ${e.message.slice(0, 200)}`);
  });
}
