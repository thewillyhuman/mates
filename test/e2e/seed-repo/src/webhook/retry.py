"""Retry policy for webhook delivery."""


class RetryPolicy:
    """Exponential backoff starting at ``base_seconds``."""

    def __init__(self, base_seconds: float = 1.0) -> None:
        self.base_seconds = base_seconds

    def delay(self, attempt: int) -> float:
        """Delay before ``attempt`` (1-based)."""
        if attempt < 1:
            raise ValueError("attempt must be >= 1")
        return self.base_seconds * (2 ** (attempt - 1))

    def should_retry(self, attempt: int) -> bool:
        return True
