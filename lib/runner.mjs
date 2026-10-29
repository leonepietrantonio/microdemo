import { spawn } from 'node:child_process';
import { access, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resultSchema } from './prompts.mjs';
import { parseRainfrogPermissions,unattended } from './permissions.mjs';

export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export async function codexBinary(config) {
  if (config.codexPath) { await access(config.codexPath); return config.codexPath; }
  const candidates = [process.env.CODEX_CLI_PATH, ...((process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'codex'))),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'];
  for (const p of candidates.filter(Boolean)) { try { await access(p); return p; } catch {} }
  throw new Error('Codex CLI not found. Install it or set codexPath in config.json.');
}

export function normalizeResult(r) {
  if (!r || !resultSchema.properties.status.enum.includes(r.status) || typeof r.summary !== 'string') throw new Error('The worker did not return a valid status. Check its log and checkpoint before resuming.');
  for (const key of ['plannedCredits', 'spentCredits']) if (!Number.isFinite(r[key]) || r[key] < 0) throw new Error(`Invalid ${key} in worker result.`);
  for (const key of ['approvals', 'outputs', 'warnings']) if (!Array.isArray(r[key])) throw new Error(`Missing ${key} in worker result.`);
  for (const a of r.approvals) {
    const url = new URL(a.url);
    if (url.protocol !== 'https:' || url.hostname !== 'app.rainfrog.ai' || !url.pathname.startsWith('/agent/approve/')) throw new Error('Worker returned an unexpected approval URL.');
    a.id=approvalIdFromURL(a.url);
  }
  if (r.projectUrl) {
    const url = new URL(r.projectUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'app.rainfrog.ai') throw new Error('Worker returned an unexpected project URL.');
  }
  return r;
}

export function approvalIdFromURL(value) {
  const url=new URL(value);
  const match=url.pathname.match(/^\/agent\/approve\/([a-zA-Z0-9-]+)\/?$/);
  if(url.protocol!=='https:'||url.hostname!=='app.rainfrog.ai'||!match)throw new Error('Invalid Rainfrog approval URL.');
  return match[1];
}

export async function hydrateApprovalIds(directory) {
  const file=path.join(directory,'manifest.json');
  const manifest=JSON.parse(await readFile(file,'utf8'));let changed=false;
  for(const shot of manifest.shots||[])if(shot.approvalUrl){const id=approvalIdFromURL(shot.approvalUrl);if(shot.approvalId!==id){shot.approvalId=id;changed=true;}}
  if(changed)await atomicJSON(file,manifest);
}

export function isLocalRuntimeFailure(message) {
  return /sandbox_apply|sandbox-exec:|failed to initialize in-process app-server|unable to open memories DB/i.test(message);
}

export function runtimeFailureMessage() {
  return 'The worker cannot execute local commands in this launch environment. Start Microdemo.command from Finder or run npm start in a normal Terminal, then Check connection and Resume. The worker keeps its workspace sandbox; existing batch data is preserved.';
}

export async function runCodex({ prompt, cwd, config, log, signal, catalogAudit=false }) {
  await mkdir(cwd, { recursive: true });
  const stamp = `${Date.now()}`;
  const schemaFile = path.join(cwd, `.schema-${stamp}.json`);
  const outputFile = path.join(cwd, `.result-${stamp}.json`);
  await atomicJSON(schemaFile, resultSchema);
  const binary = await codexBinary(config);
  // User-authorized batch actions only. Rainfrog's own approval page is still enforced by its server.
  const phase = prompt.match(/current phase is (\w+)/)?.[1];
  if(catalogAudit&&phase!=='audit')throw new Error('Unfiltered catalog inspection is restricted to a read-only audit.');
  const permissionFile=`.permissions-${randomUUID()}.json`;
  if(!unattended(config)&&!phase)prompt+=`\nINDIVIDUAL APPROVAL MODE: Call get_capabilities and save its COMPLETE real result to ${permissionFile}. Edit/Generate Ask is expected and does not prevent a successful connection check. Do not request persistent permissions. Disabled studio or Deny blocks access. Keep all calls read-only.\n`;
  if(unattended(config)){
    const permissionPolicy=!phase||phase==='audit'
      ? 'This is READ-ONLY inspection: Edit/Generate Ask is a server configuration issue for unattended runs and is NOT itself a connectivity failure. Do not request approval or call mutation/generation tools. Return ready if the requested read checks and tool availability succeeded; only Deny, disabled studio or real connectivity/tool failures block readiness.'
      : 'If the relevant action is allow, omit stale approvalId arguments and execute the saved native operations normally, reconciling existing results first. Preserve old approval URLs only as audit history. If the relevant action is ask, return needs_attention before mutations or generation: persistent permission must be configured in Rainfrog. Do not create repeated one-time approval requests or assume an Always allow button exists. Approve once does not establish a standing grant. A deny or disabled studio must stop with needs_attention.';
    prompt+=`\nSTANDING PERMISSIONS MODE: Before other Rainfrog operations call get_capabilities and save its COMPLETE real result as ${permissionFile} in this directory. ${phase==='permissions'?'Only this dedicated user-invoked permissions step may use a documented permission tool within the explicit scope above; save a fresh get_capabilities result to the SAME proof file after the attempt. Never click approval buttons.':`Never modify permissions or click approval buttons. ${permissionPolicy}`} No client flag replaces a server grant.\n`;
  }
  const proofName = `.runtime-proof-${randomUUID()}.json`;
  const proofToken = randomUUID();
  if (!phase) {
    const code = `const fs=require('node:fs');const p=${JSON.stringify(proofName)};const token=${JSON.stringify(proofToken)};fs.writeFileSync(p+'.tmp',token);fs.renameSync(p+'.tmp',p);if(fs.readFileSync(p,'utf8')!==token)throw Error('Local I/O verification failed');console.log('MICRODEMO_LOCAL_IO_OK');`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    prompt += `\nBefore any Rainfrog checks, execute this EXACT local command using the built-in shell/exec tool:\n${quote(process.execPath)} -e ${quote(code)}\nThis creates, atomically renames, and reads one scratch proof file in the current directory. Leave that proof file for the parent app to verify and remove. Do not use node_repl or cua_repl for this filesystem test. If execution fails, return needs_attention and the exact local error; do not claim ready. This local scratch test is permitted; all Rainfrog calls must remain read-only.\n`;
  }
  const readTools = ['get_account','get_capabilities','list_workspaces','list_node_types','get_node_schema','list_projects','get_project','list_assets','get_asset','list_folders','list_workflows','get_workflow','get_execution','list_executions','refresh_media_urls','open_studio'];
  const allowed = [...readTools, ...(!phase || phase === 'prepare' || phase === 'audit' ? ['create_project','create_product','move_asset','instantiate_workflow','update_node','apply_canvas_operations','preview_execution'] : []),
    ...(phase==='refresh_approval'?['update_node','apply_canvas_operations']:[]),
    ...(!phase || phase === 'generate' ? ['preview_execution','trigger_node'] : [])];
  const args = ['--search', '--disable', 'apps', '--disable', 'plugins', '-a', 'never', '-c', 'sandbox_workspace_write.network_access=true',
    // The standalone runner uses its explicit rainfrog MCP connection, not the duplicate codex_apps connector.
    // Desktop helper pipes belong to the chat process and are not a standalone worker transport.
    // A complete disabled transport also parses when the desktop helper isn't registered locally.
    '-c', `mcp_servers.node_repl={enabled=false,command=${JSON.stringify(process.execPath)}}`,
    '-c', `mcp_servers.cua_repl={enabled=false,command=${JSON.stringify(process.execPath)}}`,
    '-c', `mcp_servers.codex_app={enabled=false,command=${JSON.stringify(process.execPath)}}`,
    '-c', `mcp_servers.rainfrog.url=${JSON.stringify(config.rainfrogMcpUrl)}`,
    '-c', 'mcp_servers.rainfrog.required=true',
    ...(catalogAudit||phase==='permissions'?[]:['-c', `mcp_servers.rainfrog.enabled_tools=${JSON.stringify(allowed)}`]),
    '-c', 'mcp_servers.rainfrog.default_tools_approval_mode="approve"',
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--color', 'never',
    '--json', '--output-schema', schemaFile, '--output-last-message', outputFile, '-C', cwd, '-'];
  log('worker', 'Starting local Codex worker.');
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let buffer = '', tail = '', settled = false;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, config.stepTimeoutMinutes * 60000);
    function finish(error) { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(); }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 2_000_000) buffer = buffer.slice(-200000);
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        try {
          const event = JSON.parse(line), item = event.item;
          if (item?.type === 'agent_message' && item.text) {
            let message=item.text;
            try { const structured=JSON.parse(message); if(structured.summary)message=structured.summary; } catch {}
            log('agent', message.slice(0, 1800));
          }
          else if (item?.type === 'mcp_tool_call') log('tool', `${item.server || 'MCP'} · ${item.tool || item.name || 'tool'} · ${item.status || event.type}`);
          else if (event.type === 'error' || event.type === 'turn.failed') log('error', JSON.stringify(event).slice(0, 1200));
          else if (item?.type === 'web_search') log('research', 'Searching brand references.');
        } catch {}
      }
    });
    child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-3000); });
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(`Codex worker stopped (${code ?? 'signal'}). ${tail.slice(-1200)}`)));
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
  });
  let raw;
  try { raw = JSON.parse(await readFile(outputFile, 'utf8')); }
  catch { throw new Error('Worker ended without structured output. Check manifest.json before retrying; remote work may already exist.'); }
  const result = normalizeResult(raw);
  if(unattended(config)||!phase){
    try{result.rainfrogPermissions=parseRainfrogPermissions(JSON.parse(await readFile(path.join(cwd,permissionFile),'utf8')));}
    catch(e){result.status='needs_attention';result.summary=e.message;}
    await rm(path.join(cwd,permissionFile),{force:true});
    if(result.rainfrogPermissions&&(!result.rainfrogPermissions.studioEnabled||['read','add','edit','generate'].some(k=>result.rainfrogPermissions.actions[k]==='deny'))){result.status='needs_attention';result.summary='Rainfrog studio is disabled or an action is denied. Enable the required permissions in Rainfrog before running unattended.';}
  }
  if (!phase) {
    let proof = '';
    try { proof = await readFile(path.join(cwd,proofName),'utf8'); } catch {}
    await rm(path.join(cwd,proofName),{force:true});
    await rm(path.join(cwd,proofName+'.tmp'),{force:true});
    if (proof !== proofToken) {
      result.status='needs_attention';
      result.summary=isLocalRuntimeFailure(result.summary) ? runtimeFailureMessage() : `Local worker file access was not verified. ${result.summary}`;
    } else {
      log('runtime','Verified sandboxed worker: created, renamed, and read a local scratch file.');
    }
  }
  return result;
}
