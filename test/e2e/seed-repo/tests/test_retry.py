import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from webhook.retry import RetryPolicy  # noqa: E402


class RetryPolicyTest(unittest.TestCase):
    def test_delay_doubles(self):
        p = RetryPolicy(base_seconds=1.0)
        self.assertEqual([p.delay(n) for n in (1, 2, 3)], [1.0, 2.0, 4.0])

    def test_rejects_zero_attempt(self):
        with self.assertRaises(ValueError):
            RetryPolicy().delay(0)


if __name__ == "__main__":
    unittest.main()
