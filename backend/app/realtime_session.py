"""Realtime transcription credentials and server-side relay support.

The browser never sees the standard API key. For the preferred WebRTC
architecture the backend mints an ephemeral client secret; for the fallback
architecture the browser streams PCM16 audio over our own WebSocket and this
module relays it to the provider's realtime endpoint server-side.

NOTE (honest status): this module cannot be exercised in an environment without
an OPENAI_API_KEY and a microphone; it is covered by unit tests with fake
transports and must be smoke-tested against the real API before a live demo.
See MORNING_REVIEW.md.
"""
from __future__ import annotations

import base64
import json
import logging

import httpx

from .config import Settings

logger = logging.getLogger("hormonerx.realtime")


class RealtimeSessionError(Exception):
    pass


async def mint_client_secret(settings: Settings) -> dict:
    """Mint an ephemeral realtime client secret for browser WebRTC use."""
    if not settings.openai_api_key:
        raise RealtimeSessionError("OPENAI_API_KEY is not configured on the server")
    session_config = {
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "transcription": {
                        "model": settings.transcription_model,
                        "language": settings.transcription_language,
                    },
                    "turn_detection": {"type": "server_vad"},
                }
            },
        }
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{settings.openai_base_url}/realtime/client_secrets",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json=session_config,
        )
    if response.status_code >= 400:
        logger.error("client secret mint failed: %s %s", response.status_code, response.text[:500])
        raise RealtimeSessionError(f"provider returned {response.status_code}")
    payload = response.json()
    # Return only what the browser needs; never the server key.
    return {
        "client_secret": payload.get("value") or payload.get("client_secret", {}).get("value"),
        "expires_at": payload.get("expires_at") or payload.get("client_secret", {}).get("expires_at"),
        "model": settings.transcription_model,
    }


class ProviderRelay:
    """Server-side relay: our WebSocket audio frames -> provider realtime WS.

    Transport is injected so tests can drive the relay with fake provider events.
    """

    def __init__(self, settings: Settings, on_partial, on_final):
        self.settings = settings
        self.on_partial = on_partial  # async (text) -> None
        self.on_final = on_final  # async (item_id, text) -> None
        self._provider_ws = None

    async def connect(self, websockets_connect=None):
        import websockets

        connect = websockets_connect or websockets.connect
        if not self.settings.openai_api_key:
            raise RealtimeSessionError("OPENAI_API_KEY is not configured on the server")
        url = self.settings.openai_base_url.replace("https://", "wss://") + "/realtime?intent=transcription"
        self._provider_ws = await connect(
            url,
            additional_headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
        )
        await self._provider_ws.send(
            json.dumps(
                {
                    "type": "transcription_session.update",
                    "session": {
                        "input_audio_transcription": {
                            "model": self.settings.transcription_model,
                            "language": self.settings.transcription_language,
                        },
                        "turn_detection": {"type": "server_vad"},
                    },
                }
            )
        )

    async def send_audio(self, pcm16: bytes) -> None:
        if self._provider_ws is None:
            raise RealtimeSessionError("relay not connected")
        await self._provider_ws.send(
            json.dumps(
                {"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm16).decode("ascii")}
            )
        )

    async def handle_provider_event(self, raw: str) -> None:
        event = json.loads(raw)
        event_type = event.get("type", "")
        if event_type.endswith("input_audio_transcription.delta"):
            await self.on_partial(event.get("delta", ""))
        elif event_type.endswith("input_audio_transcription.completed"):
            await self.on_final(event.get("item_id"), event.get("transcript", ""))

    async def pump(self) -> None:
        if self._provider_ws is None:
            raise RealtimeSessionError("relay not connected")
        async for raw in self._provider_ws:
            await self.handle_provider_event(raw)

    async def close(self) -> None:
        if self._provider_ws is not None:
            await self._provider_ws.close()
            self._provider_ws = None
