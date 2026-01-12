import json
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

from app.cli.config_manager import ConfigManager, _find_config_dir
from app.cli.interactive import (
    UserCancelled,
    ask_batch_addition,
    ask_text,
    ask_yes_no,
    choose_from_list,
    display_error,
    display_existing_items,
    display_header,
    display_info,
    display_success,
    display_warning,
    handle_user_cancelled,
)

# Template format mapping
TEMPLATE_MAP = {
    "openai": "openai_template.json",
    "anthropic": "anthropic_template.json",
    "gemini": "gemini_template.json",
    "azure": "azure_template.json",
}


def add_provider_interactive() -> None:
    """
    Interactive provider addition flow.

    User Experience:
    1. Display existing providers
    2. Select provider format (templates)
    3. Enter provider details (name, display name, base URL)
    4. Confirm and save
    5. Ask if want to add another

    Handles Ctrl+C gracefully at any point.
    """
    config_manager = ConfigManager()

    try:
        add_provider_interactive_core(config_manager)
    except UserCancelled:
        handle_user_cancelled()


def add_provider_interactive_core(config_manager: ConfigManager) -> None:
    """
    Core provider addition logic - can be called from wizard or directly.

    Args:
        config_manager: ConfigManager instance for file operations

    Raises:
        UserCancelled: If user cancels the operation
    """
    _add_provider_interactive_loop(config_manager)


def _add_provider_interactive_loop(config_manager: ConfigManager) -> None:
    while True:
        # Step 1: Display existing providers
        existing_providers = config_manager.get_providers()
        display_existing_items(
            "Current Providers",
            [
                {
                    "name": p.get("display_name", p["name"]),
                    "base_url": p.get("endpoints", {}).get("base_url", "N/A"),
                    "enabled": p.get("enabled", False),
                }
                for p in existing_providers.values()
            ],
        )

        # Step 2: Select provider format
        provider_format = choose_from_list(
            "Select provider format",
            [
                "OpenAI Format",
                "Anthropic Format",
                "Google GenAI/Gemini Format",
                "Azure OpenAI Format",
                "Custom Format",
            ],
        )

        if not provider_format:
            display_warning("Provider addition cancelled")
            return

        # Step 3: Get provider details based on format
        if provider_format == "Custom Format":
            # Load custom JSON
            custom_json_path = ask_text("Enter path to custom provider config:")
            try:
                with open(custom_json_path, "r") as f:
                    provider_config = json.load(f)
            except Exception as e:
                display_error(f"Failed to load custom config: {e}")
                continue
        else:
            # Load template
            template_name = {
                "OpenAI Format": "openai_template.json",
                "Anthropic Format": "anthropic_template.json",
                "Google GenAI/Gemini Format": "gemini_template.json",
                "Azure OpenAI Format": "azure_template.json",
            }[provider_format]

            config_dir = _find_config_dir()
            template_path = config_dir / "templates" / template_name
            if not template_path.exists():
                # Fallback to current working directory
                template_path = Path("config/templates") / template_name
            with open(template_path, "r") as f:
                template_content = f.read()

            # Step 4: Enter provider details
            display_header(f"Adding {provider_format} Provider")

            def validate_provider_name(x: str):
                if not x:
                    return "Provider name cannot be empty"
                if not x.islower():
                    return "Provider name must be lowercase"
                if not x.isalnum():
                    return "Provider name must be alphanumeric (no special characters)"
                if " " in x:
                    return "Provider name cannot contain spaces"
                return True

            provider_name = ask_text(
                "Provider identifier (lowercase, no spaces, e.g., 'myprovider'):",
                validator=validate_provider_name,
            )

            if provider_name in existing_providers:
                if not ask_yes_no(
                    f"Provider '{provider_name}' already exists. Overwrite?",
                    default=False,
                ):
                    continue

            display_name = ask_text("Display name (e.g., 'My Provider'):")
            base_url = ask_text("Base URL (e.g., 'https://api.myprovider.com'):")

            # Validate URL
            try:
                parsed_url = urlparse(base_url)
                if not all([parsed_url.scheme, parsed_url.netloc]):
                    display_error("Invalid URL format. Use scheme://host format")
                    continue
            except Exception:
                display_error("Invalid URL format")
                continue

            # Step 5: Build configuration from template
            provider_name_upper = provider_name.upper()
            provider_config = json.loads(
                template_content.replace("{{provider_name}}", provider_name)
                .replace("{{display_name}}", display_name)
                .replace("{{base_url}}", base_url.rstrip("/"))
                .replace("{{provider_name_upper}}", provider_name_upper)
            )

            # Ask for optional overrides
            if ask_yes_no("Configure custom endpoints?", default=False):
                completions_endpoint = ask_text(
                    f"Completions endpoint (default: {provider_config['endpoints']['completions']}):"
                )
                if completions_endpoint:
                    provider_config["endpoints"]["completions"] = completions_endpoint

        # Step 6: Display and confirm
        display_header("Provider Configuration Preview")
        print(json.dumps(provider_config, indent=2))

        if not ask_yes_no("\nSave this provider configuration?", default=True):
            print("Provider not saved")
            if not ask_batch_addition("provider"):
                return
            continue

        # Step 7: Save configuration
        try:
            config_manager.save_provider(provider_config)
            display_success(f"Provider '{provider_name}' saved successfully")
        except Exception as e:
            display_error(f"Failed to save provider: {e}")
            continue

        # Step 8: Ask if want to add another
        if not ask_batch_addition("provider"):
            display_success("Provider addition complete")
            return
        # Continue loop for next provider


def list_providers() -> None:
    """List all configured providers with details."""
    config_manager = ConfigManager()
    providers = config_manager.get_providers()

    if not providers:
        print("No providers configured")
        return

    display_header(f"Found {len(providers)} provider(s)")

    for name, config in sorted(providers.items()):
        status = "[ENABLED]" if config.get("enabled") else "[DISABLED]"
        base_url = config.get("endpoints", {}).get("base_url", "N/A")
        print(f"  {status} {config.get('display_name', name)}")
        print(f"    ID: {name}")
        print(f"    Base URL: {base_url}")
        print(
            f"    Format: {config.get('endpoints', {}).get('compatible_format', 'unknown')}"
        )
        print()


def validate_provider_name(name: str) -> Optional[str]:
    """
    Validate provider name format.

    Args:
        name: Provider name to validate

    Returns:
        Error message if invalid, None if valid
    """
    if not name:
        return "Provider name cannot be empty"

    if not name.islower():
        return "Provider name must be lowercase"

    if not name.isalnum():
        return "Provider name must contain only alphanumeric characters"

    if " " in name:
        return "Provider name cannot contain spaces"

    return None


def validate_url(url: str) -> Optional[str]:
    """
    Validate URL format.

    Args:
        url: URL to validate

    Returns:
        Error message if invalid, None if valid
    """
    try:
        parsed = urlparse(url)
        if not all([parsed.scheme, parsed.netloc]):
            return "URL must include scheme and host (e.g., https://api.example.com)"
        if parsed.scheme not in ["http", "https"]:
            return "URL must use http:// or https://"
        return None
    except Exception:
        return "Invalid URL format"


def add_provider_non_interactive(
    name: str,
    display_name: str,
    base_url: str,
    format_type: str,
    overwrite: bool = False,
) -> None:
    """
    Add a provider non-interactively using command-line flags.

    Args:
        name: Provider identifier (lowercase, alphanumeric)
        display_name: Human-readable provider name
        base_url: Provider API base URL
        format_type: Provider format (openai, anthropic, gemini, azure)
        overwrite: Whether to overwrite existing provider

    Raises:
        ValueError: If validation fails
        FileNotFoundError: If template not found
    """
    config_manager = ConfigManager()

    # Validate provider name
    name_error = validate_provider_name(name)
    if name_error:
        display_error(f"Invalid provider name: {name_error}")
        return

    # Validate URL
    url_error = validate_url(base_url)
    if url_error:
        display_error(f"Invalid URL: {url_error}")
        return

    # Validate format type
    format_type_lower = format_type.lower()
    if format_type_lower not in TEMPLATE_MAP:
        display_error(
            f"Invalid format type: {format_type}. "
            f"Valid options: {', '.join(TEMPLATE_MAP.keys())}"
        )
        return

    # Check if provider exists
    if config_manager.provider_exists(name) and not overwrite:
        display_error(
            f"Provider '{name}' already exists. Use --overwrite to replace it."
        )
        return

    # Load template
    template_name = TEMPLATE_MAP[format_type_lower]
    config_dir = _find_config_dir()
    template_path = config_dir / "templates" / template_name

    if not template_path.exists():
        # Fallback to current working directory
        template_path = Path("config/templates") / template_name
        if not template_path.exists():
            display_error(f"Template not found: {template_path}")
            return

    try:
        with open(template_path, "r") as f:
            template_content = f.read()

        # Build configuration from template
        provider_name_upper = name.upper()
        provider_config = json.loads(
            template_content.replace("{{provider_name}}", name)
            .replace("{{display_name}}", display_name)
            .replace("{{base_url}}", base_url.rstrip("/"))
            .replace("{{provider_name_upper}}", provider_name_upper)
        )

        # Save provider
        config_manager.save_provider(provider_config, overwrite=overwrite)
        display_success(f"Provider '{name}' saved successfully")

        # Show summary
        display_info(f"  Display Name: {display_name}")
        display_info(f"  Base URL: {base_url}")
        display_info(f"  Format: {format_type_lower}")

    except json.JSONDecodeError as e:
        display_error(f"Invalid template JSON: {e}")
    except Exception as e:
        display_error(f"Failed to add provider: {e}")


def get_provider_formats() -> List[str]:
    """
    Get list of available provider formats.

    Returns:
        List of format names
    """
    return list(TEMPLATE_MAP.keys())
