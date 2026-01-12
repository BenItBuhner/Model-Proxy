from typing import Dict, List, Optional, Tuple

from app.cli.config_manager import ConfigManager
from app.cli.interactive import (
    UserCancelled,
    ask_batch_addition,
    ask_text,
    ask_yes_no,
    choose_from_list,
    choose_from_list_searchable,
    display_error,
    display_existing_items,
    display_header,
    display_info,
    display_success,
    display_warning,
    handle_user_cancelled,
    select_existing_provider,
)


def format_model_config_preview(model_config: Dict) -> str:
    """
    Format model configuration dictionary into a clean, readable list format.

    Args:
        model_config: Dictionary containing model configuration

    Returns:
        Formatted string representation of the configuration
    """
    lines = []

    # Logical name
    logical_name = model_config.get("logical_name", "N/A")
    lines.append(f"Logical Name: {logical_name}")

    # Timeout
    timeout = model_config.get("timeout_seconds", "N/A")
    lines.append(f"Timeout: {timeout} seconds")

    # Primary model routings
    model_routings = model_config.get("model_routings", [])
    if model_routings:
        lines.append("\nPrimary Models:")
        for i, routing in enumerate(model_routings, 1):
            provider = routing.get("provider", "N/A")
            model = routing.get("model", "N/A")
            lines.append(f"  {i}. {provider} / {model}")
    else:
        lines.append("\nPrimary Models: None")

    # Fallback logical models (schema: List[str])
    fallback_models = model_config.get("fallback_model_routings", [])
    if isinstance(fallback_models, list) and fallback_models:
        # Support both correct schema (List[str]) and legacy/mistaken shapes gracefully
        if all(isinstance(x, str) for x in fallback_models):
            lines.append("\nFallback Logical Models:")
            for i, name in enumerate(fallback_models, 1):
                lines.append(f"  {i}. {name}")
        else:
            lines.append("\nFallback (unrecognized format):")
            for i, item in enumerate(fallback_models, 1):
                lines.append(f"  {i}. {item}")
    else:
        lines.append("\nFallback Logical Models: None")

    return "\n".join(lines)


def add_model_interactive() -> None:
    """
    Interactive model configuration flow.

    User Experience:
    1. Display existing models
    2. Select provider from existing providers
    3. Display available models for selected provider
    4. Select model(s) to add (multi-select)
    5. Configure routing/priority for models
    6. Save configuration
    7. Ask if want to add another

    Handles Ctrl+C gracefully at any point.
    """
    config_manager = ConfigManager()

    try:
        add_model_interactive_core(config_manager)
    except UserCancelled:
        handle_user_cancelled()


def _routing_display(routing: Dict) -> str:
    provider = routing.get("provider", "N/A")
    model = routing.get("model", "N/A")
    return f"{provider} / {model}"


def _dedupe_routings(routings: List[Dict]) -> List[Dict]:
    """Deduplicate routings by (provider, model) while preserving first-seen order."""
    seen = set()
    deduped: List[Dict] = []
    for r in routings:
        key = (r.get("provider"), r.get("model"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped


def _prompt_ordered_fallback_models(existing_models: List[str]) -> List[str]:
    """
    Prompt user for an ordered list of fallback logical models.

    Schema expects `fallback_model_routings: List[str]` (logical model names).
    Order matters: earlier entries are tried first.
    """
    if not existing_models:
        return []

    if not ask_yes_no(
        "Add fallback logical models (tried if all routes fail)?", default=False
    ):
        return []

    remaining = sorted(existing_models)
    ordered: List[str] = []

    while remaining:
        next_model = choose_from_list(
            "Select next fallback logical model (in order):",
            remaining + ["[DONE] Finish fallback list"],
            allow_multiple=False,
            include_cancel=False,
        )

        if next_model == "[DONE] Finish fallback list":
            break

        ordered.append(next_model)
        remaining = [m for m in remaining if m != next_model]

        if not remaining:
            break

        if not ask_yes_no("Add another fallback logical model?", default=False):
            break

    return ordered


def _configure_and_save_model_config(
    config_manager: ConfigManager,
    selected_routings: List[Dict],
    *,
    default_logical_name: Optional[str] = None,
) -> bool:
    """
    Given concrete provider/model routings, run the routing config UX and save a model config.
    """
    selected_routings = _dedupe_routings(selected_routings)
    if not selected_routings:
        display_warning("No models selected")
        return False

    existing_models = config_manager.get_models()

    display_header("Model Routing Configuration")
    print("\nSelected routes:")
    for i, r in enumerate(selected_routings, 1):
        print(f"  {i}. {_routing_display(r)}")

    print("\nYou can:")
    print("  - Create a new logical model with these routes")
    print(
        "  - Add these routes to an existing logical model (as additional fallback routes)"
    )

    config_type = choose_from_list(
        "Configuration type:",
        [
            "Standalone model (create new logical model)",
            "Add to existing model (append routes)",
        ],
        allow_multiple=False,
    )

    if config_type == "Standalone model (create new logical model)":
        logical_name = ask_text(
            "Logical model name:",
            default=default_logical_name or "",
            validator=lambda x: True
            if x and x.strip()
            else "Model name cannot be empty",
        )

        timeout = ask_text(
            "Timeout in seconds (default: 240):",
            default="240",
        )

        # Route ordering
        if len(selected_routings) > 1:
            print("\nConfigure route order (lower number = tried first):")
            priorities: Dict[str, int] = {}
            for idx, r in enumerate(selected_routings, 1):
                disp = _routing_display(r)
                priority_str = ask_text(
                    f"Priority for '{disp}' (default {idx}):",
                    default=str(idx),
                )
                priorities[disp] = int(priority_str) if priority_str.isdigit() else idx

            ordered_routings = sorted(
                selected_routings,
                key=lambda r: priorities.get(_routing_display(r), 9999),
            )
        else:
            ordered_routings = selected_routings

        fallback_models = _prompt_ordered_fallback_models(
            [m for m in existing_models if m != logical_name]
        )

        model_config = {
            "logical_name": logical_name,
            "timeout_seconds": int(timeout) if timeout.isdigit() else 240,
            "model_routings": ordered_routings,
            "fallback_model_routings": fallback_models,
        }
        overwrite_existing = False

    else:  # Add to existing model (append routes)
        if not existing_models:
            display_error("No existing model configurations found to add routes to.")
            return False

        existing_logical_model = choose_from_list(
            "Select existing model to add these routes to:",
            existing_models,
            allow_multiple=False,
        )

        existing_config = config_manager.get_model_config(existing_logical_model)
        existing_routes = existing_config.get("model_routings", [])
        if not isinstance(existing_routes, list):
            existing_routes = []
        merged_routes = _dedupe_routings(existing_routes + selected_routings)

        existing_config["model_routings"] = merged_routes
        if "fallback_model_routings" not in existing_config or not isinstance(
            existing_config.get("fallback_model_routings"), list
        ):
            existing_config["fallback_model_routings"] = []

        model_config = existing_config
        logical_name = existing_logical_model
        overwrite_existing = True

    # Preview and confirm save
    display_header("Model Configuration Preview")
    print(format_model_config_preview(model_config))

    try:
        should_save = ask_yes_no("\nSave this model configuration?", default=True)
    except UserCancelled:
        # Treat Ctrl+C at the final save prompt as "don't save", not as a hard abort.
        should_save = False

    if not should_save:
        print("Model configuration not saved")
        return False

    try:
        try:
            config_manager.save_model_config(
                logical_name, model_config, overwrite=overwrite_existing
            )
        except ValueError as e:
            # Standalone case: allow overwrite if user confirms
            if not overwrite_existing and "already exists" in str(e):
                if ask_yes_no(
                    f"Model '{logical_name}' already exists. Overwrite it?",
                    default=False,
                ):
                    config_manager.save_model_config(
                        logical_name, model_config, overwrite=True
                    )
                else:
                    display_info("Model configuration not saved")
                    return False
            else:
                raise

        display_success(f"Model '{logical_name}' saved successfully")

        # Refresh cache (optional)
        try:
            import asyncio

            from app.cli.discovery import discover_and_cache_models

            # Background refresh should be quiet (avoid cluttering interactive UX).
            asyncio.run(discover_and_cache_models(quiet=True))
        except Exception:
            pass

    except Exception as e:
        display_error(f"Failed to save model: {e}")
        return False

    return True


def _get_all_models_with_providers(config_manager: ConfigManager) -> List[tuple]:
    """
    Get all available models from all providers.

    Returns:
        List of (display_string, provider, model) tuples
    """
    cache = config_manager.get_models_cache()
    discovered = cache.get("discovered_models", {})
    custom = cache.get("custom_models", {})

    all_provider_names = set(discovered.keys()) | set(custom.keys())

    results = []
    for provider in sorted(all_provider_names):
        provider_discovered = discovered.get(provider, [])
        provider_custom = custom.get(provider, [])
        provider_models = sorted(set(provider_discovered + provider_custom))

        for model in provider_models:
            display = f"{provider} / {model}"
            results.append((display, provider, model))

    return results


def _parse_model_selection(selection: str) -> tuple:
    """
    Parse a 'provider / model' string back to (provider, model) tuple.

    Args:
        selection: String in format "provider / model"

    Returns:
        (provider, model) tuple
    """
    parts = selection.split(" / ", 1)
    if len(parts) == 2:
        return (parts[0], parts[1])
    return (None, selection)


def add_model_interactive_core(config_manager: ConfigManager) -> None:
    """
    Core model addition logic - can be called from wizard or directly.

    Args:
        config_manager: ConfigManager instance for file operations

    Raises:
        UserCancelled: If user cancels the operation
    """
    _add_model_interactive_loop(config_manager)


def _add_model_interactive_loop(config_manager: ConfigManager) -> None:
    """Internal loop for model addition - can raise UserCancelled."""
    while True:
        # Step 1: Display existing models
        existing_models = config_manager.get_models()
        display_existing_items(
            "Current Model Configurations", [{"name": m} for m in existing_models]
        )

        # Step 2: Get all available models from ALL providers
        all_models_data = _get_all_models_with_providers(config_manager)

        if not all_models_data:
            display_warning("No models available from any provider")
            print("\nOptions:")
            print("  1. Add custom model (if provider doesn't list models)")
            print("  2. Refresh model cache")
            print("  3. Cancel\n")

            action = choose_from_list(
                "Choose action:", ["Add custom model", "Refresh model cache", "Cancel"]
            )

            if action == "Add custom model":
                # Need to pick a provider first for custom model
                provider_choice = select_existing_provider(
                    context="Select provider for custom model"
                )
                model_id = ask_text("Enter model ID/name as used by the API:")
                all_models_data = [
                    (f"{provider_choice} / {model_id}", provider_choice, model_id)
                ]
            elif action == "Refresh model cache":
                if ask_yes_no(
                    "This will attempt to fetch models from provider API. Continue?",
                    default=True,
                ):
                    import asyncio

                    from app.cli.discovery import discover_and_cache_models

                    asyncio.run(discover_and_cache_models())
                    all_models_data = _get_all_models_with_providers(config_manager)
                    if not all_models_data:
                        display_error("No models discovered. Try adding custom model.")
                        continue
                else:
                    continue
            else:
                continue

        # Step 3: Select models from combined list (all providers)
        display_strings = [item[0] for item in all_models_data]

        display_header("Model Selection")
        print(
            "Select models from any provider. Models are shown as 'provider / model'."
        )
        print(
            "Pick one model at a time (Enter to add). You can keep adding until you're done.\n"
        )

        selected_display: List[str] = []
        remaining_choices = display_strings.copy()

        while True:
            if selected_display:
                print(f"\nSelected ({len(selected_display)}):")
                for i, s in enumerate(selected_display, 1):
                    print(f"  {i}. {s}")

            if not remaining_choices:
                display_info("No more models available to add.")
                break

            try:
                next_choice = choose_from_list_searchable(
                    "Select a model to add (Enter to add, Esc/Ctrl+C when done):",
                    remaining_choices,
                    allow_multiple=False,
                    search_placeholder="models",
                )
            except UserCancelled:
                # If they've already selected something, treat cancel as "done selecting".
                if selected_display:
                    break
                raise

            if not next_choice:
                continue

            if next_choice in selected_display:
                display_warning("Model already selected")
            else:
                selected_display.append(next_choice)
                remaining_choices = [c for c in remaining_choices if c != next_choice]

            if not remaining_choices:
                break

            if not ask_yes_no("Add another model?", default=True):
                break

        if not selected_display:
            display_warning("No models selected")
            continue

        # Parse selections back to (provider, model) tuples
        selected_routings = []
        for display in selected_display:
            provider, model = _parse_model_selection(display)
            if provider:
                selected_routings.append({"provider": provider, "model": model})

        if not selected_routings:
            display_warning("No valid models selected")
            continue

        # Step 4: Configure + save configuration
        _configure_and_save_model_config(config_manager, selected_routings)

        # Step 5: Ask if want to add another
        if not ask_batch_addition("model"):
            display_success("Model configuration complete")
            return


def add_custom_model_interactive() -> None:
    """
    Interactive custom model addition for providers with incomplete model listings.

    User Experience:
    1. Display existing custom models
    2. Select provider (arrow navigation)
    3. Enter model ID/name
    4. Confirm and save to cache
    5. Ask if want to add another

    Handles Ctrl+C gracefully at any point.
    """
    config_manager = ConfigManager()

    try:
        _add_custom_model_interactive_loop(config_manager)
    except UserCancelled:
        handle_user_cancelled()


def _add_custom_model_interactive_loop(config_manager: ConfigManager) -> None:
    """Internal loop for custom model addition - can raise UserCancelled."""
    # Track routes the user wants to use for a config in this session.
    # (Include even if the model already existed in the cache.)
    session_routings: List[Dict] = []

    # Stage cache updates until the user finishes. This prevents "pile-ups" when
    # the user is experimenting and cancels before saving a model config.
    pending_cache_additions: List[Tuple[str, str]] = []
    pending_cache_set = set()

    while True:
        # Step 1: Display existing custom models
        cache = config_manager.get_models_cache()
        custom_models = cache.get("custom_models", {})

        display_header("Existing Custom Models")
        has_custom = False
        for provider, models in sorted(custom_models.items()):
            if models:
                has_custom = True
                print(f"  - {provider}:")
                for model in models:
                    print(f"      {model}")

        if not has_custom:
            print("  No custom models configured")

        # Show models selected this session
        if session_routings:
            print(f"\n  Selected this session: {len(session_routings)}")
            for r in session_routings:
                print(f"    + {_routing_display(r)}")

        # Show pending cache additions (not yet written to disk)
        if pending_cache_additions:
            print("\n  Pending cache additions (NOT saved yet):")
            for provider, model in pending_cache_additions:
                print(f"    * {provider} / {model}")

        # Step 2: Select ONE provider
        print()
        try:
            provider_choice = select_existing_provider(
                context="Select provider for custom model"
            )
        except UserCancelled:
            # If the user cancels provider selection but they've already entered
            # some models, treat it as "done adding models" (not a hard abort).
            if session_routings:
                break
            raise

        # Step 3: Enter model ID
        display_header(f"Adding custom model to {provider_choice}")
        print("Enter the model ID exactly as the provider's API expects it")

        model_id = ask_text("Model ID/name:")

        if not model_id:
            display_warning("Model ID cannot be empty")
            continue

        routing = {"provider": provider_choice, "model": model_id}
        session_routings = _dedupe_routings(session_routings + [routing])

        # Step 4: Stage cache update (don't write yet)
        existing_for_provider = set(custom_models.get(provider_choice, []))
        if model_id in existing_for_provider:
            display_warning(
                f"Custom model '{model_id}' already exists in cache for {provider_choice}"
            )
        else:
            key = (provider_choice, model_id)
            if key not in pending_cache_set:
                pending_cache_set.add(key)
                pending_cache_additions.append(key)
            display_info(
                f"Staged for cache (will only be saved if you finish): {provider_choice} / {model_id}"
            )

        # Always show what will be usable in routing config this session
        display_info(f"Selected for config: {provider_choice} / {model_id}")

        # Step 5: Ask if want to add another
        if not ask_yes_no("Add another custom model?", default=True):
            break

    if not session_routings:
        display_info("No custom models selected")
        return

    # Step 6: Continue into full routing config + save
    try:
        continue_to_config = ask_yes_no(
            "Continue to configure and save a logical model using these routes now?",
            default=True,
        )
    except UserCancelled:
        continue_to_config = False

    saved_config = False
    if continue_to_config:
        try:
            saved_config = _configure_and_save_model_config(
                config_manager, session_routings
            )
        except UserCancelled:
            display_warning(
                "Configuration cancelled. No model configuration was saved."
            )
            saved_config = False

    # Step 7: Persist staged cache updates (optional / conditional)
    if pending_cache_additions:
        # If the user saved a config, default to saving the cache too. Otherwise default to NOT
        # saving the cache (prevents unwanted pile-ups from aborted runs).
        default_save_cache = True if saved_config else False
        if not continue_to_config:
            # If they explicitly chose not to configure now, they probably just wanted cache entries.
            default_save_cache = True

        try:
            save_cache = ask_yes_no(
                f"Save {len(pending_cache_additions)} new custom model(s) to the cache (config/models.json)?",
                default=default_save_cache,
            )
        except UserCancelled:
            save_cache = False

        if save_cache:
            try:
                latest_cache = config_manager.get_models_cache()
                if "custom_models" not in latest_cache:
                    latest_cache["custom_models"] = {}

                added_count = 0
                for provider, model in pending_cache_additions:
                    latest_cache["custom_models"].setdefault(provider, [])
                    if model not in latest_cache["custom_models"][provider]:
                        latest_cache["custom_models"][provider].append(model)
                        latest_cache["custom_models"][provider].sort()
                        added_count += 1

                config_manager.update_models_cache(latest_cache)
                display_success(
                    f"Custom model cache updated - added {added_count} model(s)"
                )
            except Exception as e:
                display_error(f"Failed to update custom model cache: {e}")
        else:
            display_info("Custom model cache not changed")

    if continue_to_config and not saved_config:
        display_info("Model configuration not saved")
    elif continue_to_config and saved_config:
        display_success("Model configuration saved")
    else:
        display_info("Skipped creating a model configuration")

    return


def list_model_configs() -> None:
    """List all configured model configurations."""
    config_manager = ConfigManager()
    models = config_manager.get_models()

    if not models:
        print("No model configurations found")
        return

    display_header(f"Found {len(models)} model configuration(s)")

    for model in sorted(models):
        try:
            config = config_manager.get_model_config(model)
            timeout = config.get("timeout_seconds", "N/A")
            primary_count = len(config.get("model_routings", []))
            fallback_count = len(config.get("fallback_model_routings", []))

            print(f"  • {model}")
            print(f"    Timeout: {timeout}s")
            print(f"    Primary models: {primary_count}")
            print(f"    Fallback chains: {fallback_count}")
            print()

        except Exception as e:
            display_error(f"Failed to load model config {model}: {e}")


def get_available_models_for_provider(provider_name: str) -> List[str]:
    """
    Get available models for a specific provider.

    Args:
        provider_name: Name of the provider

    Returns:
        List of available model IDs
    """
    config_manager = ConfigManager()
    cache = config_manager.get_models_cache()

    discovered = cache.get("discovered_models", {}).get(provider_name, [])
    custom = cache.get("custom_models", {}).get(provider_name, [])

    return sorted(set(discovered + custom))


def add_model_non_interactive(
    logical_name: str,
    provider: str,
    model_id: str,
    timeout: int = 240,
    overwrite: bool = False,
) -> None:
    """
    Add a model configuration non-interactively using command-line flags.

    Args:
        logical_name: Logical name for the model configuration
        provider: Provider name
        model_id: Model ID from the provider
        timeout: Timeout in seconds
        overwrite: Whether to overwrite existing config

    Raises:
        ValueError: If validation fails
    """
    config_manager = ConfigManager()

    # Validate logical name
    if not logical_name or not logical_name.strip():
        display_error("Logical name cannot be empty")
        return

    # Validate provider exists
    if not config_manager.provider_exists(provider):
        display_error(f"Provider '{provider}' does not exist. Add it first.")
        return

    # Validate timeout
    if timeout <= 0:
        display_error("Timeout must be a positive integer")
        return

    # Check if model config exists
    if config_manager.model_config_exists(logical_name) and not overwrite:
        display_error(
            f"Model config '{logical_name}' already exists. Use --overwrite to replace it."
        )
        return

    # Build model configuration
    model_config = {
        "logical_name": logical_name,
        "timeout_seconds": timeout,
        "model_routings": [{"provider": provider, "model": model_id}],
        "fallback_model_routings": [],
    }

    try:
        config_manager.save_model_config(
            logical_name, model_config, overwrite=overwrite
        )
        display_success(f"Model config '{logical_name}' saved successfully")

        # Show summary
        display_info(f"  Provider: {provider}")
        display_info(f"  Model: {model_id}")
        display_info(f"  Timeout: {timeout}s")

    except Exception as e:
        display_error(f"Failed to save model config: {e}")


def add_custom_model_non_interactive(provider: str, model_id: str) -> None:
    """
    Add a custom model to the cache non-interactively.

    Args:
        provider: Provider name
        model_id: Model ID to add

    Raises:
        ValueError: If validation fails
    """
    config_manager = ConfigManager()

    # Validate provider exists
    if not config_manager.provider_exists(provider):
        display_error(f"Provider '{provider}' does not exist. Add it first.")
        return

    # Validate model ID
    if not model_id or not model_id.strip():
        display_error("Model ID cannot be empty")
        return

    try:
        cache = config_manager.get_models_cache()

        if "custom_models" not in cache:
            cache["custom_models"] = {}
        if provider not in cache["custom_models"]:
            cache["custom_models"][provider] = []

        if model_id in cache["custom_models"][provider]:
            display_warning(f"Custom model '{model_id}' already exists for {provider}")
            return

        cache["custom_models"][provider].append(model_id)
        cache["custom_models"][provider].sort()

        config_manager.update_models_cache(cache)
        display_success(f"Custom model '{model_id}' added for {provider}")

    except Exception as e:
        display_error(f"Failed to add custom model: {e}")
