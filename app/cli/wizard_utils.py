"""
Shared utilities for the Model-Proxy setup wizard.

Provides status checking, progress display, and smart recommendations
for the unified setup wizard experience.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.cli.config_manager import ConfigManager


def get_setup_status(config_manager: ConfigManager) -> Dict:
    """
    Get current setup status and recommendations.

    Returns:
        Dict with status information including:
        - providers_count: Number of configured providers
        - models_count: Number of configured models
        - api_keys_count: Number of API keys configured
        - completed_steps: List of completed steps
        - recommendations: List of recommendations
        - progress_percentage: Overall progress percentage
    """
    # Get provider status
    providers = config_manager.get_providers()
    providers_count = len(providers)
    enabled_providers = sum(1 for p in providers.values() if p.get("enabled", False))

    # Get model status
    models = config_manager.get_models()
    models_count = len(models)

    # Get API key status
    api_keys_count = 0
    providers_with_keys = 0

    for provider_name, provider_config in providers.items():
        if not provider_config.get("enabled"):
            continue

        provider_upper = provider_name.upper()
        patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

        for pattern in patterns:
            if "{INDEX}" in pattern:
                for i in range(1, 10):
                    env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                    if os.getenv(env_var):
                        api_keys_count += 1
            else:
                env_var = pattern.format(PROVIDER=provider_upper)
                if os.getenv(env_var):
                    api_keys_count += 1

        # Check if this provider has at least one API key
        has_keys = False
        for pattern in patterns:
            if "{INDEX}" in pattern:
                for i in range(1, 10):
                    env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                    if os.getenv(env_var):
                        has_keys = True
                        break
            else:
                env_var = pattern.format(PROVIDER=provider_upper)
                if os.getenv(env_var):
                    has_keys = True
                    break
        if has_keys:
            providers_with_keys += 1

    # Determine completed steps
    completed_steps = []
    if providers_count > 0:
        completed_steps.append("providers")
    if models_count > 0:
        completed_steps.append("models")
    if api_keys_count > 0:
        completed_steps.append("api_keys")

    # Generate recommendations
    recommendations = []

    if providers_count == 0:
        recommendations.append("Add at least one LLM provider to get started")
    elif enabled_providers == 0:
        recommendations.append(
            "Enable your configured providers in the provider settings"
        )

    if models_count == 0 and providers_count > 0:
        recommendations.append("Configure model routing for your providers")

    if providers_with_keys == 0 and providers_count > 0:
        recommendations.append("Add API keys to enable your providers")
    elif providers_with_keys < enabled_providers:
        recommendations.append(
            f"Add API keys for {enabled_providers - providers_with_keys} remaining provider(s)"
        )

    # Calculate progress percentage
    total_steps = 3  # providers, models, api_keys
    progress_percentage = int((len(completed_steps) / total_steps) * 100)

    return {
        "providers_count": providers_count,
        "enabled_providers": enabled_providers,
        "models_count": models_count,
        "api_keys_count": api_keys_count,
        "providers_with_keys": providers_with_keys,
        "completed_steps": completed_steps,
        "recommendations": recommendations,
        "progress_percentage": progress_percentage,
    }


def should_skip_step(step: str, config_manager: ConfigManager) -> bool:
    """
    Determine if a setup step should be skipped based on current configuration.

    Args:
        step: The step to check ("providers", "models", or "api_keys")
        config_manager: ConfigManager instance for checking current state

    Returns:
        True if the step should be skipped, False otherwise
    """
    if step == "providers":
        # Skip if providers exist
        return len(config_manager.get_providers()) > 0

    elif step == "models":
        # Skip if models exist and providers are configured
        return (
            len(config_manager.get_models()) > 0
            and len(config_manager.get_providers()) > 0
        )

    elif step == "api_keys":
        # Skip if all enabled providers have at least one key
        providers = config_manager.get_providers()
        for provider_name, provider_config in providers.items():
            if not provider_config.get("enabled"):
                continue

            provider_upper = provider_name.upper()
            patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

            has_keys = False
            for pattern in patterns:
                if "{INDEX}" in pattern:
                    for i in range(1, 10):
                        env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                        if os.getenv(env_var):
                            has_keys = True
                            break
                else:
                    env_var = pattern.format(PROVIDER=provider_upper)
                    if os.getenv(env_var):
                        has_keys = True
                        break

            if not has_keys:
                return False  # At least one provider has no keys

        return True  # All providers have keys

    return False


def create_progress_bar(current: int, total: int, width: int = 50) -> str:
    """
    Create a visual progress bar.

    Args:
        current: Current step number (1-based)
        total: Total number of steps
        width: Width of the progress bar in characters

    Returns:
        String representation of the progress bar
    """
    if total <= 0:
        return ""

    filled_width = int((current / total) * width)
    empty_width = width - filled_width

    # Create progress bar with symbols that work across platforms
    filled = "█" * filled_width
    empty = "░" * empty_width

    percentage = int((current / total) * 100)

    return f"[{filled}{empty}] {percentage}% ({current}/{total})"


def format_step_status(step: str, completed: bool) -> str:
    """
    Format step display with status indicator.

    Args:
        step: The step name
        completed: Whether the step is completed

    Returns:
        Formatted step string
    """
    status_symbol = "[✓]" if completed else "[ ]"
    step_names = {"providers": "Providers", "models": "Models", "api_keys": "API Keys"}

    step_name = step_names.get(step, step.title())
    return f"{status_symbol} {step_name}"


def display_setup_status(config_manager: ConfigManager) -> None:
    """
    Display current setup status with progress.

    Args:
        config_manager: ConfigManager instance
    """
    status = get_setup_status(config_manager)

    # Display header
    print("Current Setup Status")
    print("=" * 50)

    # Display progress bar
    print(f"Overall Progress: {create_progress_bar(len(status['completed_steps']), 3)}")
    print()

    # Display step status
    steps = ["providers", "models", "api_keys"]
    for step in steps:
        completed = step in status["completed_steps"]
        print(f"  {format_step_status(step, completed)}")

    print()
    print(
        f"Providers: {status['enabled_providers']}/{status['providers_count']} enabled"
    )
    print(f"Models: {status['models_count']} configured")
    print(f"API Keys: {status['api_keys_count']} configured")

    # Display recommendations
    if status["recommendations"]:
        print("\nRecommendations:")
        for i, rec in enumerate(status["recommendations"], 1):
            print(f"  {i}. {rec}")


def get_step_name(step: str) -> str:
    """
    Get human-readable step name.

    Args:
        step: The step identifier

    Returns:
        Human-readable step name
    """
    step_names = {
        "providers": "Provider Configuration",
        "models": "Model Configuration",
        "api_keys": "API Key Setup",
    }
    return step_names.get(step, step.title())


def validate_prerequisites(
    step: str, config_manager: ConfigManager
) -> Tuple[bool, List[str]]:
    """
    Check if prerequisites are met for a step.

    Args:
        step: The step to check prerequisites for
        config_manager: ConfigManager instance

    Returns:
        Tuple of (prerequisites_met, missing_prerequisites)
    """
    missing = []

    if step == "models":
        if not config_manager.get_providers():
            missing.append("Providers must be configured first")

    elif step == "api_keys":
        providers = config_manager.get_providers()
        if not providers:
            missing.append("Providers must be configured first")
        else:
            # Check if any provider is enabled
            enabled = [p for p in providers.values() if p.get("enabled")]
            if not enabled:
                missing.append("At least one provider must be enabled")

    return len(missing) == 0, missing


def save_progress_to_file(
    progress: Dict, file_path: str = ".model-proxy-setup-progress"
) -> None:
    """
    Save wizard progress to a temporary file.

    Args:
        progress: Progress data to save
        file_path: Path to save progress file
    """
    try:
        with open(file_path, "w") as f:
            json.dump(progress, f, indent=2)
    except Exception:
        # Silently fail progress saving - not critical
        pass


def load_progress_from_file(
    file_path: str = ".model-proxy-setup-progress",
) -> Optional[Dict]:
    """
    Load wizard progress from file.

    Args:
        file_path: Path to progress file

    Returns:
        Progress data if file exists and is valid, None otherwise
    """
    try:
        if Path(file_path).exists():
            with open(file_path, "r") as f:
                return json.load(f)
    except Exception:
        pass

    return None


def clear_progress_file(file_path: str = ".model-proxy-setup-progress") -> None:
    """
    Clear saved progress file.

    Args:
        file_path: Path to progress file
    """
    try:
        if Path(file_path).exists():
            Path(file_path).unlink()
    except Exception:
        pass


def format_model_config_summary(models: List[Dict]) -> str:
    """
    Format model configuration summary for display.

    Args:
        models: List of model configurations

    Returns:
        Formatted summary string
    """
    if not models:
        return "No models configured"

    summary = []
    for model in models[:5]:  # Show first 5 models
        name = model.get("logical_name", "Unknown")
        routings = len(model.get("model_routings", []))
        fallbacks = len(model.get("fallback_model_routings", []))

        summary.append(f"  • {name}: {routings} route(s), {fallbacks} fallback(s)")

    if len(models) > 5:
        summary.append(f"  ... and {len(models) - 5} more models")

    return "\n".join(summary)
