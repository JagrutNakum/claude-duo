"""
Abstract base class for Claude-Duo internet communication channels.
"""

from abc import ABC, abstractmethod
from typing import Callable, Optional, Dict, Any

class BaseChannel(ABC):
    def __init__(self, config: Dict[str, Any], global_config: Dict[str, Any]):
        self.config = config
        self.global_config = global_config
        self.user_name = global_config.get("user_name", "User")
        self.machine_id = global_config.get("machine_id", "machine")

    @abstractmethod
    def publish_event(self, event_type: str, title: str, message: str,
                      payload: Optional[Dict[str, Any]] = None, priority: int = 3) -> bool:
        """
        Publish an alert, notification, or ping over the internet.
        Priority: 1=low, 3=normal, 4=high, 5=urgent.
        """
        pass

    @abstractmethod
    def publish_state(self, state_dict: Dict[str, Any]) -> bool:
        """
        Publish machine usage metrics and heartbeat so the peer can read it.
        """
        pass

    @abstractmethod
    def fetch_peer_state(self) -> Optional[Dict[str, Any]]:
        """
        Fetch the latest state published by the peer.
        """
        pass

    @abstractmethod
    def start_listener(self, on_message: Callable[[Dict[str, Any]], None]):
        """
        Start listening for incoming messages/events in background thread.
        """
        pass

    @abstractmethod
    def stop_listener(self):
        """
        Stop listener background thread.
        """
        pass
