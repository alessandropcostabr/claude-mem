#!/usr/bin/env python3
"""
patch-telegram.py — Reaplicar patches claude-mem no Telegram plugin.

Patches aplicados:
  1. bot.on('message_reaction') → POST /api/metrics/telegram-reaction
  2. bot.start({ allowed_updates: [..., 'message_reaction'] })
  3. MCP keepalive: setInterval a cada 3min para evitar idle timeout do claude-patched

Uso:
  python3 patch-telegram.py             # detecta versão ativa automaticamente
  python3 patch-telegram.py 0.0.6       # versão explícita
  python3 patch-telegram.py --check     # só verifica, não altera
"""

import sys
import os
from pathlib import Path

CACHE_DIR = Path.home() / ".claude/plugins/cache/claude-plugins-official/telegram"
WORKER_URL = "http://localhost:37777"

# Bloco a encontrar (fim do handler de sticker)
STICKER_END = """bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})"""

# Bloco de substituição (sticker + handler de reação)
STICKER_WITH_REACTION = STICKER_END + """

// claude-mem patch: capture user reactions as feedback signals
bot.on('message_reaction', async ctx => {
  try {
    const newReactions = ctx.messageReaction?.new_reaction ?? []
    if (newReactions.length === 0) return
    const emoji = newReactions.find(r => r.type === 'emoji')?.emoji ?? '👍'
    const userId = String(ctx.messageReaction?.user?.id ?? ctx.messageReaction?.actor_chat?.id ?? 'unknown')
    await fetch('http://localhost:37777/api/metrics/telegram-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, userId }),
    }).catch(() => {})
  } catch {}
})"""

# bot.start() original
BOT_START_ORIGINAL = """      await bot.start({
        onStart: info => {"""

# bot.start() patchado
BOT_START_PATCHED = """      await bot.start({
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
        onStart: info => {"""

# Keepalive: anchor (right after mcp.connect)
MCP_CONNECT_ANCHOR = "await mcp.connect(new StdioServerTransport())\n\n// When Claude Code closes"

# Keepalive: bloco inserido após mcp.connect para evitar idle timeout do claude-patched
MCP_KEEPALIVE_BLOCK = """await mcp.connect(new StdioServerTransport())

// Keepalive: prevent claude-patched MCP idle timeout (~5min)
// Escreve notification JSON-RPC de debug a cada 3min para manter stdin ativo.
setInterval(() => {
  try {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'debug', logger: 'telegram-keepalive', data: 'ping' }
    })
    process.stdout.write(msg + '\\n')
  } catch {}
}, 180_000).unref()

// When Claude Code closes"""


def get_active_version():
    def parse_ver(name: str):
        try:
            return tuple(int(x) for x in name.split("."))
        except ValueError:
            return ()

    versions = sorted(CACHE_DIR.iterdir(), key=lambda p: parse_ver(p.name)) if CACHE_DIR.exists() else []
    versions = [v for v in versions if (v / "server.ts").exists()]
    return versions[-1] if versions else None


def check_patched(content: str) -> dict:
    return {
        "message_reaction": "message_reaction" in content,
        "allowed_updates": "allowed_updates" in content,
        "keepalive": "telegram-keepalive" in content or "mcp.ping()" in content,
    }


def apply_patch(server_ts: Path, check_only=False) -> bool:
    content = server_ts.read_text()
    status = check_patched(content)

    print(f"  server.ts: {server_ts}")
    print(f"  message_reaction: {'✅ present' if status['message_reaction'] else '❌ missing'}")
    print(f"  allowed_updates:  {'✅ present' if status['allowed_updates'] else '❌ missing'}")
    print(f"  keepalive:        {'✅ present' if status['keepalive'] else '❌ missing'}")

    if all(status.values()):
        print("  → Already fully patched.")
        return True

    if check_only:
        print("  → Patch needed (--check mode, not applying).")
        return False

    if not status['message_reaction']:
        if STICKER_END not in content:
            print("  ERROR: sticker block not found — server.ts layout may have changed.")
            return False
        content = content.replace(STICKER_END, STICKER_WITH_REACTION, 1)

    if not status['allowed_updates']:
        if BOT_START_ORIGINAL not in content:
            print("  ERROR: bot.start block not found — server.ts layout may have changed.")
            return False
        content = content.replace(BOT_START_ORIGINAL, BOT_START_PATCHED, 1)

    if not status['keepalive']:
        if MCP_CONNECT_ANCHOR not in content:
            print("  ERROR: mcp.connect anchor not found — server.ts layout may have changed.")
            return False
        content = content.replace(MCP_CONNECT_ANCHOR, MCP_KEEPALIVE_BLOCK, 1)

    server_ts.write_text(content)
    print("  → Patch applied successfully.")
    print("  → Restart the bot: pkill -f 'bun.*server.ts' (claude-patched will respawn it)")
    return True


def main():
    check_only = "--check" in sys.argv
    explicit_ver = next((a for a in sys.argv[1:] if not a.startswith("-")), None)

    if explicit_ver:
        ver_dir = CACHE_DIR / explicit_ver
        if not ver_dir.exists():
            print(f"ERROR: version {explicit_ver} not found in {CACHE_DIR}")
            sys.exit(1)
    else:
        ver_dir = get_active_version()
        if not ver_dir:
            print(f"ERROR: no Telegram plugin found in {CACHE_DIR}")
            sys.exit(1)

    print(f"Telegram plugin: {ver_dir.name}")
    server_ts = ver_dir / "server.ts"
    ok = apply_patch(server_ts, check_only=check_only)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
