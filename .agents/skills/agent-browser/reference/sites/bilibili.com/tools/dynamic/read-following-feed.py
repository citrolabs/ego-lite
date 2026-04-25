#!/usr/bin/env python3
# ---
# name: read-following-feed
# description: Read recent authenticated Bilibili following dynamic feed items.
# inputs:
#   - pages
#   - limit
# ---

"""Read recent Bilibili following feed items through the page-context API."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any


SCRAPE_JS = r"""
(async ({pages, limit}) => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const fullUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    return url;
  };
  const safeJson = (value) => {
    if (!value || typeof value !== 'string') return value || {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };
  const itemText = (dynamic) => normalize(dynamic?.desc?.text);
  const fromMajor = (item) => {
    const dynamic = item.modules?.module_dynamic || {};
    const major = dynamic.major || {};
    const base = {kind: item.type, title: itemText(dynamic), summary: '', url: '', duration: '', play: ''};

    if (major.archive) {
      return {
        kind: 'video',
        title: normalize(major.archive.title),
        summary: normalize(major.archive.desc),
        url: fullUrl(major.archive.jump_url),
        duration: major.archive.duration_text || '',
        play: major.archive.stat?.play || '',
      };
    }
    if (major.article) {
      return {
        kind: 'article',
        title: normalize(major.article.title),
        summary: normalize(major.article.desc),
        url: fullUrl(major.article.jump_url),
        duration: '',
        play: '',
      };
    }
    if (major.draw) {
      const count = major.draw.items?.length || 0;
      return {...base, kind: 'image', summary: count ? `${count} images` : ''};
    }
    if (major.common) {
      return {
        kind: normalize(major.common.badge?.text) || 'common',
        title: normalize(major.common.title) || base.title,
        summary: normalize(major.common.desc),
        url: fullUrl(major.common.jump_url),
        duration: '',
        play: '',
      };
    }
    if (major.live_rcmd) {
      const content = safeJson(major.live_rcmd.content);
      const live = content.live_play_info || {};
      return {
        kind: 'live',
        title: normalize(live.title),
        summary: normalize([live.area_name, live.watched_show?.text_large].filter(Boolean).join(' · ')),
        url: fullUrl(live.link),
        duration: '',
        play: live.watched_show?.text_small || '',
      };
    }

    return base;
  };
  const summarize = (item) => {
    const author = item.modules?.module_author || {};
    const stats = item.modules?.module_stat || {};
    const content = fromMajor(item);

    if (item.type === 'DYNAMIC_TYPE_FORWARD' && item.orig) {
      const original = fromMajor(item.orig);
      content.kind = 'forward';
      content.summary = normalize(
        [
          item.modules?.module_dynamic?.desc?.text,
          original.title ? `forwarded: ${original.title}` : '',
        ].filter(Boolean).join(' | ')
      );
      content.url = content.url || original.url;
    }

    return {
      id: item.id_str || '',
      up: author.name || '',
      time: author.pub_time || '',
      timestamp: author.pub_ts || 0,
      action: author.pub_action || '',
      type: content.kind,
      title: content.title,
      summary: content.summary,
      url: content.url,
      duration: content.duration,
      play: content.play,
      comments: stats.comment?.count ?? 0,
      likes: stats.like?.count ?? 0,
      forwards: stats.forward?.count ?? 0,
    };
  };

  const items = [];
  let offset = '';
  let hasMore = false;
  for (let page = 1; page <= pages && items.length < limit; page += 1) {
    const params = new URLSearchParams({
      type: 'all',
      timezone_offset: '-480',
      page: String(page),
    });
    if (offset) params.set('offset', offset);
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?${params}`;
    const response = await fetch(url, {credentials: 'include'});
    const payload = await response.json();
    if (payload.code !== 0) {
      throw new Error(`Bilibili feed API returned ${payload.code}: ${payload.message || 'unknown error'}`);
    }
    items.push(...(payload.data?.items || []).map(summarize));
    offset = payload.data?.offset || '';
    hasMore = Boolean(payload.data?.has_more && offset);
    if (!hasMore) break;
  }

  return {
    url: location.href,
    count: Math.min(items.length, limit),
    has_more: hasMore,
    next_offset: hasMore ? offset : '',
    items: items.slice(0, limit),
  };
})
"""


def yaml_scalar(value: Any) -> str:
    """Format primitive values as conservative YAML scalars."""
    if value is None:
        return '""'
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value)
    if text == "":
        return '""'
    needs_quotes = any(char in text for char in [": ", "#", "\n", '"', "[", "]", "{", "}"])
    if needs_quotes or text.strip() != text:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def emit_yaml(data: dict[str, Any]) -> str:
    """Emit a small YAML subset without requiring external packages."""
    lines: list[str] = []

    def emit_value(key: str, value: Any, indent: int) -> None:
        prefix = " " * indent
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            for child_key, child_value in value.items():
                emit_value(child_key, child_value, indent + 2)
            return
        if isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    pairs = list(item.items())
                    if not pairs:
                        lines.append(f"{prefix}  - {{}}")
                        continue
                    first_key, first_value = pairs[0]
                    lines.append(f"{prefix}  - {first_key}: {yaml_scalar(first_value)}")
                    for child_key, child_value in pairs[1:]:
                        emit_value(child_key, child_value, indent + 4)
                else:
                    lines.append(f"{prefix}  - {yaml_scalar(item)}")
            return
        lines.append(f"{prefix}{key}: {yaml_scalar(value)}")

    for key, value in data.items():
        emit_value(key, value, 0)
    return "\n".join(lines) + "\n"


def run_eval(pages: int, limit: int) -> dict[str, Any]:
    """Run the read-only feed request inside the connected browser session."""
    script = f"({SCRAPE_JS})({json.dumps({'pages': pages, 'limit': limit})})"
    result = subprocess.run(
        ["agent-browser", "--auto-connect", "eval", script],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "agent-browser eval failed")
    return json.loads(result.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=int, default=1, help="Maximum feed pages to read.")
    parser.add_argument("--limit", type=int, default=25, help="Maximum items to return.")
    args = parser.parse_args()

    try:
        # Keep bounds small so a reusable tool cannot accidentally scrape deeply.
        pages = min(max(args.pages, 1), 5)
        limit = min(max(args.limit, 1), 100)
        data = run_eval(pages=pages, limit=limit)
    except Exception as exc:  # noqa: BLE001 - CLI tools should return structured failure.
        sys.stdout.write(emit_yaml({"status": "error", "message": str(exc)}))
        return 1

    sys.stdout.write(
        emit_yaml(
            {
                "status": "ok",
                "message": f"Read {data.get('count', 0)} Bilibili following feed items.",
                "data": data,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
