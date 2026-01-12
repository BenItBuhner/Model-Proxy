import os
from pathlib import Path
from typing import List, Optional

from app.cli.config_manager import ConfigManager
from app.cli.interactive import (
    UserCancelled,
    ask_password,
    ask_yes_no,
    choose_from_list,
    display_error,
    display_header,
    display_info,
    display_success,
    display_warning,
    handle_user_cancelled,
    select_existing_provider,
)


def add_api_key_interactive() -> None:
    """
    Interactive API key management flow.

    User Experience:
    1. Display existing API keys (censored)
    2. Select provider (arrow navigation)
    3. Enter API key (hidden input)
    4. Confirm and save
    5. Present options loop:
       a. Add another for same provider
       b. Add for different provider
       c. Exit

    Handles Ctrl+C gracefully at any point.
    """
    config_manager = ConfigManager()

    try:
        add_api_key_interactive_core(config_manager)
    except UserCancelled:
        handle_user_cancelled()


def add_api_key_interactive_core(config_manager: ConfigManager) -> None:
    """
    Core API key addition logic - can be called from wizard or directly.

    Args:
        config_manager: ConfigManager instance for file operations

    Raises:
        UserCancelled: If user cancels the operation
    """
    _add_api_key_interactive_loop(config_manager)


def _add_api_key_interactive_loop(config_manager: ConfigManager) -> None:
    current_provider = None

    while True:
        # Step 1: Display existing keys
        display_header("Current API Keys (last 4 characters shown)")

        providers = config_manager.get_providers()
        if not providers:
            display_warning(
                "No providers configured. Run 'model-proxy add provider' first."
            )
            raise UserCancelled()

        total_keys = 0
        for provider_name, provider_config in sorted(providers.items()):
            if not provider_config.get("enabled"):
                continue

            provider_upper = provider_name.upper()
            patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

            keys_found = []
            for pattern in patterns:
                if "{INDEX}" in pattern:
                    # Check multiple indices
                    for i in range(1, 10):  # Check up to 10 keys
                        env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                        value = os.getenv(env_var)
                        if value:
                            censored = "*" * (len(value) - 4) + value[-4:]
                            keys_found.append((env_var, censored))
                else:
                    env_var = pattern.format(PROVIDER=provider_upper)
                    value = os.getenv(env_var)
                    if value:
                        censored = "*" * (len(value) - 4) + value[-4:]
                        keys_found.append((env_var, censored))

            display_name = provider_config.get("display_name", provider_name)
            if keys_found:
                print(f"\n• {display_name} ({provider_name}):")
                for env_var, censored in keys_found:
                    print(f"  {env_var}: {censored}")
                total_keys += len(keys_found)
            else:
                print(f"\n• {display_name} ({provider_name}): [No keys]")

        if total_keys == 0:
            print("\nNo API keys configured yet")

        # Step 2: Select provider (from existing providers only)
        if current_provider is None:
            provider_choice = select_existing_provider(
                context="Select provider to add API key to"
            )
            current_provider = provider_choice
        else:
            print(f"\nCurrent provider: {current_provider}")
            if not ask_yes_no("Add key for this provider?", default=True):
                # Let them choose different provider
                provider_choice = select_existing_provider(
                    context="Select provider to add API key to"
                )
                current_provider = provider_choice

        # Step 3: Get provider config for key patterns
        # At this point current_provider is guaranteed to be a string
        # (select_existing_provider raises UserCancelled if cancelled)
        assert current_provider is not None

        provider_config = providers.get(current_provider)
        if not provider_config:
            display_error(f"Provider not found: {current_provider}")
            current_provider = None
            continue

        provider_upper = current_provider.upper()
        patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

        if not patterns:
            display_error(f"No API key patterns defined for {current_provider}")
            current_provider = None
            continue

        # Step 4: Find next available env var
        env_var_to_use = None
        key_index = None

        # Check which indices are available
        used_indices = []
        for pattern in patterns:
            if "{INDEX}" in pattern:
                for i in range(1, 10):
                    env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                    if os.getenv(env_var):
                        used_indices.append(i)

        # Find first unused index
        for i in range(1, 10):
            if i not in used_indices:
                key_index = i
                env_var_to_use = patterns[0].format(
                    PROVIDER=provider_upper, INDEX=key_index
                )
                break

        if env_var_to_use is None:
            # All 10 slots used, try without index
            for pattern in patterns:
                if "{INDEX}" not in pattern:
                    env_var_to_use = pattern.format(PROVIDER=provider_upper)
                    break

        if env_var_to_use is None:
            display_error("All API key slots are full (10 keys max)")
            current_provider = None
            continue

        # Step 5: Get API key from user
        display_header(
            f"Adding API key for {provider_config.get('display_name', current_provider)}"
        )
        print(f"Will be saved to environment variable: {env_var_to_use}")

        api_key = ask_password("Enter API key:")

        if not api_key:
            display_warning("API key cannot be empty")
            continue

        # Basic validation
        if len(api_key) < 10:
            if not ask_yes_no("API key seems short. Continue?", default=False):
                continue

        # Step 6: Confirm
        censored = "*" * (len(api_key) - 4) + api_key[-4:]
        print(f"\nWill save API key: {censored}")
        print(f"To: {env_var_to_use}")

        if not ask_yes_no("Confirm?", default=True):
            print("API key not saved")
            continue

        # Step 7: Save to .env file
        try:
            env_file = Path(".env")

            # Check if env var already exists
            existing_lines = []
            var_found = False

            if env_file.exists():
                with open(env_file, "r") as f:
                    existing_lines = f.readlines()

            # Update or add the variable
            new_lines = []
            for line in existing_lines:
                if line.strip().startswith(env_var_to_use + "="):
                    new_lines.append(f"{env_var_to_use}={api_key}\n")
                    var_found = True
                else:
                    new_lines.append(line)

            if not var_found:
                new_lines.append(
                    f"\n# {provider_config.get('display_name', current_provider)} API Key\n"
                )
                new_lines.append(f"{env_var_to_use}={api_key}\n")

            with open(env_file, "w") as f:
                f.writelines(new_lines)

            # Also set in current environment
            os.environ[env_var_to_use] = api_key

            display_success(f"API key saved to {env_var_to_use}")

        except Exception as e:
            display_error(f"Failed to save API key: {e}")
            continue

        # Step 8: Present next action options
        display_header("What would you like to do next?")

        next_action = choose_from_list(
            "Choose next action:",
            [
                f"Add another API key for {current_provider}",
                "Add API key for different provider",
                "[DONE] Exit",
            ],
        )

        # Ensure we have a string value
        action_str = next_action if isinstance(next_action, str) else ""

        if action_str.startswith("Add another"):
            # Keep current provider, continue loop
            continue
        elif "different provider" in action_str:
            # Reset current provider to force selection
            current_provider = None
            continue
        else:
            # Exit
            display_success("API key configuration complete")
            return


def list_api_keys() -> None:
    """List all configured API keys (censored)."""
    config_manager = ConfigManager()

    display_header("Configured API Keys")

    providers = config_manager.get_providers()
    total_keys = 0

    if not providers:
        print("No providers configured")
        return

    for provider_name, provider_config in sorted(providers.items()):
        if not provider_config.get("enabled"):
            continue

        provider_upper = provider_name.upper()
        patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

        keys_found = []
        for pattern in patterns:
            if "{INDEX}" in pattern:
                for i in range(1, 10):
                    env_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                    value = os.getenv(env_var)
                    if value:
                        censored = "*" * (len(value) - 4) + value[-4:]
                        keys_found.append((env_var, censored))
            else:
                env_var = pattern.format(PROVIDER=provider_upper)
                value = os.getenv(env_var)
                if value:
                    censored = "*" * (len(value) - 4) + value[-4:]
                    keys_found.append((env_var, censored))

        display_name = provider_config.get("display_name", provider_name)
        print(f"\n• {display_name} ({provider_name}):")

        if keys_found:
            for env_var, censored in keys_found:
                print(f"  {env_var}: {censored}")
            total_keys += len(keys_found)
        else:
            print("  [No keys configured]")

    print("\n" + "=" * 60)
    print(f"Total: {total_keys} API key(s) configured")
    print("=" * 60)


def get_api_key_env_vars(provider_name: str) -> List[str]:
    """
    Get environment variable names for a provider's API keys.

    Args:
        provider_name: Name of the provider

    Returns:
        List of environment variable names
    """
    config_manager = ConfigManager()
    provider_config = config_manager.get_provider(provider_name)

    if not provider_config:
        return []

    provider_upper = provider_name.upper()
    patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

    env_vars = []
    for pattern in patterns:
        if "{INDEX}" in pattern:
            for i in range(1, 10):
                env_vars.append(pattern.format(PROVIDER=provider_upper, INDEX=i))
        else:
            env_vars.append(pattern.format(PROVIDER=provider_upper))

    return env_vars


def validate_api_key_format(key: str) -> bool:
    """
    Validate API key format (basic checks).

    Args:
        key: API key to validate

    Returns:
        True if key appears valid
    """
    if not key:
        return False

    if len(key) < 10:
        return False

    # Basic format checks
    if key.startswith("sk-") or key.startswith("gsk_") or key.startswith("sk-ant-"):
        return True

    # Allow custom keys that are reasonably long
    return len(key) >= 20


def add_api_key_non_interactive(
    provider: str,
    api_key: str,
    env_var: Optional[str] = None,
) -> None:
    """
    Add an API key non-interactively using command-line flags.

    Args:
        provider: Provider name
        api_key: API key value
        env_var: Custom environment variable name (optional)

    Raises:
        ValueError: If validation fails
    """
    config_manager = ConfigManager()

    # Validate provider exists
    provider_config = config_manager.get_provider(provider)
    if not provider_config:
        display_error(f"Provider '{provider}' does not exist. Add it first.")
        return

    # Validate API key
    if not api_key or not api_key.strip():
        display_error("API key cannot be empty")
        return

    if len(api_key) < 10:
        display_warning("API key seems short (less than 10 characters)")

    provider_upper = provider.upper()

    # Determine environment variable name
    if env_var:
        env_var_to_use = env_var
    else:
        # Find next available slot
        patterns = provider_config.get("api_keys", {}).get("env_var_patterns", [])

        if not patterns:
            display_error(f"No API key patterns defined for {provider}")
            return

        # Check which indices are used
        used_indices = []
        for pattern in patterns:
            if "{INDEX}" in pattern:
                for i in range(1, 10):
                    test_var = pattern.format(PROVIDER=provider_upper, INDEX=i)
                    if os.getenv(test_var):
                        used_indices.append(i)

        # Find first unused index
        env_var_to_use = None
        for i in range(1, 10):
            if i not in used_indices:
                for pattern in patterns:
                    if "{INDEX}" in pattern:
                        env_var_to_use = pattern.format(
                            PROVIDER=provider_upper, INDEX=i
                        )
                        break
                break

        if env_var_to_use is None:
            # Try pattern without index
            for pattern in patterns:
                if "{INDEX}" not in pattern:
                    env_var_to_use = pattern.format(PROVIDER=provider_upper)
                    break

        if env_var_to_use is None:
            display_error("All API key slots are full (10 keys max)")
            return

    try:
        env_file = Path(".env")

        # Read existing lines
        existing_lines = []
        var_found = False

        if env_file.exists():
            with open(env_file, "r") as f:
                existing_lines = f.readlines()

        # Update or add the variable
        new_lines = []
        for line in existing_lines:
            if line.strip().startswith(env_var_to_use + "="):
                new_lines.append(f"{env_var_to_use}={api_key}\n")
                var_found = True
            else:
                new_lines.append(line)

        if not var_found:
            new_lines.append(
                f"\n# {provider_config.get('display_name', provider)} API Key\n"
            )
            new_lines.append(f"{env_var_to_use}={api_key}\n")

        with open(env_file, "w") as f:
            f.writelines(new_lines)

        # Set in current environment
        os.environ[env_var_to_use] = api_key

        # Show censored key
        censored = "*" * (len(api_key) - 4) + api_key[-4:]
        display_success(f"API key saved to {env_var_to_use}")
        display_info(f"  Key: {censored}")

    except Exception as e:
        display_error(f"Failed to save API key: {e}")
