"""
Internet communication channels for Claude-Duo.
Supports ntfy (zero setup), Discord webhooks, Telegram bots, Upstash Redis, and generic HTTP Webhooks.
"""

from .base import BaseChannel
from .ntfy_channel import NtfyChannel
from .discord_channel import DiscordChannel
from .telegram_channel import TelegramChannel
from .upstash_channel import UpstashChannel
from .webhook_channel import WebhookChannel

def get_channel(cfg: dict) -> BaseChannel:
    channel_type = cfg.get("channel", "ntfy").lower()
    ch_cfgs = cfg.get("channels_config", {})
    if channel_type == "ntfy":
        return NtfyChannel(ch_cfgs.get("ntfy", {}), cfg)
    elif channel_type == "discord":
        return DiscordChannel(ch_cfgs.get("discord", {}), cfg)
    elif channel_type == "telegram":
        return TelegramChannel(ch_cfgs.get("telegram", {}), cfg)
    elif channel_type == "upstash":
        return UpstashChannel(ch_cfgs.get("upstash", {}), cfg)
    elif channel_type in ("webhook", "custom"):
        return WebhookChannel(ch_cfgs.get("webhook", {}), cfg)
    else:
        # Fallback to ntfy
        return NtfyChannel(ch_cfgs.get("ntfy", {}), cfg)
