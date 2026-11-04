"""
Model pricing definitions and cost estimation for Claude models.
Rates per million tokens ($/MTok).
"""

MODEL_RATES = {
    # Sonnet models (Sonnet 3.5, 3.7, 4.5, 5.5)
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-3-7-sonnet": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-sonnet-4-5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-sonnet-5-5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    # Opus models
    "claude-3-opus": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-4": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-5": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-5-5": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    # Haiku models
    "claude-3-5-haiku": {"input": 0.80, "output": 4.00, "cache_read": 0.08, "cache_write": 1.00},
    "claude-3-haiku": {"input": 0.25, "output": 1.25, "cache_read": 0.03, "cache_write": 0.30},
    "claude-haiku-4-5": {"input": 0.80, "output": 4.00, "cache_read": 0.08, "cache_write": 1.00},
}

DEFAULT_RATE = {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75}

def get_rates_for_model(model_name: str) -> dict:
    if not model_name:
        return DEFAULT_RATE
    clean = model_name.lower().strip()
    for key, rate in MODEL_RATES.items():
        if key in clean:
            return rate
    if "opus" in clean:
        return MODEL_RATES["claude-3-opus"]
    if "haiku" in clean:
        return MODEL_RATES["claude-3-5-haiku"]
    return DEFAULT_RATE

def estimate_cost(model_name: str, input_tokens: int = 0, output_tokens: int = 0,
                  cache_read: int = 0, cache_write: int = 0) -> float:
    rates = get_rates_for_model(model_name)
    cost = (
        (input_tokens / 1_000_000.0) * rates["input"] +
        (output_tokens / 1_000_000.0) * rates["output"] +
        (cache_read / 1_000_000.0) * rates["cache_read"] +
        (cache_write / 1_000_000.0) * rates["cache_write"]
    )
    return round(cost, 6)
