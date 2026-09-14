"""FamGateway Client implementation"""
import hmac
import hashlib
import json
import requests
from typing import Optional, Union, Dict, Any

from .exceptions import (
    FamGatewayError,
    AuthenticationError,
    APIError,
    OrderNotFoundError,
    NetworkError,
)
from .models import OrderResponse, OrderStatus

DEFAULT_BASE_URL = "https://famgateway.in"
DEFAULT_TIMEOUT = 15  # seconds


class FamGateway:
    """FamGateway Python Client

    Usage:
        >>> from famgateway import FamGateway
        >>> fg = FamGateway(api_key="your_api_key")
        >>> order = fg.create_order(amount=100.0)
        >>> print(order.qr_url)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        if not api_key or not isinstance(api_key, str):
            raise AuthenticationError("A valid FamGateway api_key string is required.")

        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "FamGateway-Python-SDK/1.0.4",
            "Accept": "application/json",
        })

    def _request(self, method: str, endpoint: str, params: Optional[dict] = None, data: Optional[dict] = None) -> dict:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        kwargs = {"params": params, "timeout": self.timeout}
        if method.upper() != "GET" and data is not None:
            kwargs["json"] = data

        try:
            resp = self.session.request(method=method, url=url, **kwargs)
        except requests.exceptions.RequestException as e:
            raise NetworkError(f"Network error connecting to FamGateway: {str(e)}") from e

        try:
            result = resp.json()
        except json.JSONDecodeError:
            raise APIError(
                f"Invalid JSON response from FamGateway API (HTTP {resp.status_code})",
                status_code=resp.status_code,
            )

        if resp.status_code == 401 or result.get("status") == "unauthorized":
            raise AuthenticationError(
                result.get("message", "Invalid or missing FamGateway API Key"),
                status_code=resp.status_code,
                response_body=result,
            )

        if resp.status_code == 404 or result.get("status") == "not_found":
            raise OrderNotFoundError(
                result.get("message", "Order ID or payment link not found"),
                status_code=resp.status_code,
                response_body=result,
            )

        if resp.status_code == 408 or result.get("status") == "expired":
            return result

        if resp.status_code >= 400 or result.get("status") in ("error", "failed"):
            raise APIError(
                result.get("message", result.get("error", "FamGateway API Request Failed")),
                status_code=resp.status_code,
                response_body=result,
            )

        return result

    def create_order(
        self,
        amount: Union[int, float, str],
        customer_name: Optional[str] = None,
        customer_email: Optional[str] = None,
        customer_phone: Optional[str] = None,
        redirect_url: Optional[str] = None,
        webhook_url: Optional[str] = None,
    ) -> OrderResponse:
        try:
            amt_float = round(float(amount), 2)
            if amt_float <= 0:
                raise ValueError("Amount must be greater than 0")
        except (ValueError, TypeError):
            raise ValueError(f"Invalid amount provided: {amount}")

        params = {"api_key": self.api_key, "amount": amt_float}
        if customer_name:
            params["customer_name"] = str(customer_name)[:100]
        if customer_email:
            params["customer_email"] = str(customer_email)
        if customer_phone:
            params["customer_phone"] = str(customer_phone)
        if redirect_url:
            params["redirect_url"] = str(redirect_url)
        if webhook_url:
            params["webhook_url"] = str(webhook_url)

        res = self._request("GET", "/api/qr.php", params=params)
        data = res.get("data", {})
        return OrderResponse(data)

    def get_status(self, order_id: str) -> OrderStatus:
        if not order_id:
            raise ValueError("order_id is required")
        params = {"order_id": order_id.strip()}
        res = self._request("GET", "/api/checkout-status.php", params=params)
        return OrderStatus(res)

    def verify_order(self, order_id: str) -> OrderStatus:
        if not order_id:
            raise ValueError("order_id is required")
        params = {"api_key": self.api_key, "order_id": order_id.strip()}
        res = self._request("GET", "/api/verify-order.php", params=params)
        return OrderStatus(res)

    def simulate_payment(self, order_id: str) -> dict:
        if not order_id:
            raise ValueError("order_id is required")
        params = {"api_key": self.api_key, "order_id": order_id.strip()}
        return self._request("GET", "/api/simulate-payment.php", params=params)

    @staticmethod
    def verify_webhook_signature(payload: Union[str, bytes], signature: str, api_key: str) -> bool:
        if not payload or not signature or not api_key:
            return False
        payload_bytes = payload.encode("utf-8") if isinstance(payload, str) else payload
        computed = hmac.new(api_key.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, signature.strip())

    def verify_webhook(self, payload: Union[str, bytes], signature: str) -> bool:
        return FamGateway.verify_webhook_signature(payload, signature, self.api_key)