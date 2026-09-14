"""Data models for FamGateway API responses"""
from typing import Optional, Dict, Any


def _to_float(v) -> float:
    try:
        return float(v) if v is not None and v != "" else 0.0
    except (ValueError, TypeError):
        return 0.0


class BaseResponse:
    """Wrapper that allows both attribute access (obj.foo) and dict access (obj['foo'])."""

    def __init__(self, raw: Dict[str, Any]):
        self._raw = raw or {}

    def __getitem__(self, item):
        return self._raw[item]

    def __contains__(self, item):
        return item in self._raw

    def get(self, key, default=None):
        return self._raw.get(key, default)

    def to_dict(self) -> Dict[str, Any]:
        return self._raw

    def __repr__(self):
        return f"{self.__class__.__name__}({self._raw})"


class OrderResponse(BaseResponse):
    """Response returned when an order is created."""

    @property
    def order_id(self) -> str:
        return self._raw.get("order_id", "")

    @property
    def qr_url(self) -> str:
        """Direct URL of the generated QR code image."""
        return self._raw.get("qr_url", "")

    @property
    def checkout_url(self) -> str:
        """Hosted web checkout URL."""
        return self._raw.get("checkout_url", "")

    @property
    def upi_id(self) -> str:
        """The receiver FamPay / UPI ID."""
        return self._raw.get("upi_id", "")

    @property
    def amount(self) -> float:
        return _to_float(self._raw.get("amount"))

    @property
    def payable_amount(self) -> float:
        return _to_float(self._raw.get("payable_amount"))

    @property
    def upi_intent(self) -> str:
        """Deep link (upi://pay?...) for opening UPI apps directly."""
        return self._raw.get("upi_intent", "")

    @property
    def created_at_ist(self) -> str:
        return self._raw.get("created_at_ist", "")

    @property
    def expires_at_ist(self) -> str:
        return self._raw.get("expires_at_ist", "")


class OrderStatus(BaseResponse):
    """Response returned when checking or verifying the status of an order."""

    def __init__(self, raw: Dict[str, Any]):
        flattened = dict(raw or {})
        if isinstance(flattened.get("data"), dict):
            flattened.update(flattened["data"])
        super().__init__(flattened)

    @property
    def order_id(self) -> str:
        return self._raw.get("order_id", "")

    @property
    def status(self) -> str:
        """Current status: 'success', 'pending', 'expired', or 'failed'."""
        return str(self._raw.get("status", "pending")).lower()

    @property
    def is_paid(self) -> bool:
        return self.status in ("success", "paid", "captured")

    @property
    def is_pending(self) -> bool:
        return self.status == "pending"

    @property
    def is_expired(self) -> bool:
        return self.status == "expired"

    @property
    def amount(self) -> float:
        return _to_float(self._raw.get("amount"))

    @property
    def payable_amount(self) -> float:
        return _to_float(self._raw.get("payable_amount") or self._raw.get("amount"))

    @property
    def utr(self) -> Optional[str]:
        return self._raw.get("utr")

    @property
    def transaction_id(self) -> Optional[str]:
        return self._raw.get("transaction_id")

    @property
    def sender_name(self) -> Optional[str]:
        return self._raw.get("sender_name") or self._raw.get("customer_name")

    @property
    def payment_time(self) -> Optional[str]:
        return self._raw.get("payment_time_ist") or self._raw.get("payment_time")

    @property
    def payment_time_ist(self) -> Optional[str]:
        return self._raw.get("payment_time_ist") or self._raw.get("payment_time")