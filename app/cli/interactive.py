"""
Interactive prompt utilities for Model-Proxy CLI.

This module provides reusable, cross-platform interactive prompt functions
with arrow key navigation, validation, and formatted output.

All interactive functions handle Ctrl+C (KeyboardInterrupt) gracefully,
allowing users to exit at any point without crashing.
"""

import sys
from typing import Callable, Dict, List, Optional, Union

import questionary
import typer
from prompt_toolkit import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import HSplit, Layout, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.formatted_text import FormattedText


class UserCancelled(Exception):
    """Raised when user cancels an operation with Ctrl+C."""

    pass


def _handle_keyboard_interrupt(func):
    """
    Decorator to handle KeyboardInterrupt gracefully.

    When questionary receives Ctrl+C, it returns None.
    This decorator checks for None and raises UserCancelled.
    """

    def wrapper(*args, **kwargs):
        try:
            result = func(*args, **kwargs)
            # questionary returns None on Ctrl+C
            if result is None and func.__name__ not in (
                "display_success",
                "display_error",
                "display_warning",
                "display_info",
                "display_header",
                "display_existing_items",
                "censor_string",
                "pause_for_review",
            ):
                raise UserCancelled()
            return result
        except KeyboardInterrupt:
            raise UserCancelled()

    wrapper.__name__ = func.__name__
    wrapper.__doc__ = func.__doc__
    return wrapper


def handle_user_cancelled():
    """
    Handle UserCancelled exception - display message and exit gracefully.
    Call this in except UserCancelled blocks.
    """
    print()  # New line after ^C
    # Don't claim a specific key combo here; user may have selected an explicit
    # "[X] Cancel" option rather than pressing Ctrl+C.
    display_warning("Operation cancelled by user")
    raise typer.Exit(0)


def select_existing_provider(
    context: str = "Select a provider",
    include_all: bool = False,
    allow_none: bool = False,
) -> Optional[str]:
    """
    Display existing providers for selection (without "add new" option).

    Use this when you need the user to select from existing providers only,
    such as when adding models to an existing provider.

    Args:
        context: The prompt message to display
        include_all: Whether to include an "All providers" option
        allow_none: If True, returns None when no providers exist instead of warning

    Returns:
        Selected provider name, "ALL" if all providers selected, or None if cancelled/no providers

    Raises:
        UserCancelled: If user presses Ctrl+C or selects Cancel
    """
    try:
        from app.core.provider_config import (
            get_all_provider_configs,
            is_provider_enabled,
        )
    except ImportError:
        display_error("Could not load provider configurations")
        raise UserCancelled()

    providers = get_all_provider_configs()
    enabled_providers = [p for p in providers if is_provider_enabled(p)]

    if not enabled_providers:
        if allow_none:
            return None
        display_warning(
            "No enabled providers found. Run 'model-proxy add provider' first."
        )
        raise UserCancelled()

    # Sort providers alphabetically
    enabled_providers.sort()

    # Build choices
    choices = []

    # Add provider display names
    for provider in enabled_providers:
        config = providers[provider]
        display_name = config.get("display_name", provider)
        choices.append(
            questionary.Choice(title=f"{display_name} ({provider})", value=provider)
        )

    # Add extra options
    from questionary import Separator

    if include_all:
        choices.append(Separator())
        choices.append(questionary.Choice(title="[ALL] All providers", value="ALL"))

    choices.append(Separator())
    choices.append(questionary.Choice(title="[X] Cancel", value="__CANCEL__"))

    try:
        choice = questionary.select(
            f"{context}:", choices=choices, use_shortcuts=True
        ).ask()

        # questionary returns None on Ctrl+C
        if choice is None or choice == "__CANCEL__":
            raise UserCancelled()

        return choice
    except KeyboardInterrupt:
        raise UserCancelled()


def ask_provider_selection(
    context: str = "Select a provider", include_all: bool = False
) -> Optional[str]:
    """
    Display existing providers with arrow key navigation.
    Includes "New provider" option at the end.

    Args:
        context: The prompt message to display
        include_all: Whether to include an "All providers" option

    Returns:
        Selected provider name, None if "New provider" chosen, or
        "ALL" if all providers selected

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        from app.core.provider_config import (
            get_all_provider_configs,
            is_provider_enabled,
        )
    except ImportError:
        display_error("Could not load provider configurations")
        return None

    providers = get_all_provider_configs()
    enabled_providers = [p for p in providers if is_provider_enabled(p)]

    if not enabled_providers:
        display_warning("No enabled providers found")
        return None

    # Sort providers alphabetically
    enabled_providers.sort()

    # Build choices
    choices = []

    # Add provider display names
    for provider in enabled_providers:
        config = providers[provider]
        display_name = config.get("display_name", provider)
        choices.append(
            questionary.Choice(title=f"{display_name} ({provider})", value=provider)
        )

    # Add extra options
    from questionary import Separator

    if include_all:
        choices.append(Separator())
        choices.append(questionary.Choice(title="[ALL] All providers", value="ALL"))

    choices.append(Separator())
    choices.append(questionary.Choice(title="[+] New provider", value=None))
    choices.append(Separator())
    choices.append(questionary.Choice(title="[X] Cancel (Ctrl+C)", value="__CANCEL__"))

    try:
        choice = questionary.select(
            f"{context}:", choices=choices, use_shortcuts=True
        ).ask()

        # questionary returns None on Ctrl+C
        if choice is None or choice == "__CANCEL__":
            raise UserCancelled()

        return choice
    except KeyboardInterrupt:
        raise UserCancelled()


def ask_yes_no(message: str, default: bool = True) -> bool:
    """
    Ask yes/no question with arrow key navigation.

    Args:
        message: Prompt message
        default: Default selection (True for Yes, False for No)

    Returns:
        User's choice (True for Yes, False for No)

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        result = questionary.confirm(message, default=default).ask()
        if result is None:
            raise UserCancelled()
        return result
    except KeyboardInterrupt:
        raise UserCancelled()


def ask_text(
    message: str,
    default: str = "",
    validator: Optional[Callable[[str], any]] = None,
    multiline: bool = False,
) -> str:
    """
    Ask for text input with optional validation.

    Args:
        message: Prompt message
        default: Default value
        validator: Validation function that returns True for valid input,
                   or an error message string for invalid input
        multiline: Whether to allow multiline input

    Returns:
        Validated text input

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        result = questionary.text(
            message, default=default, validate=validator, multiline=multiline, qmark="?"
        ).ask()
        if result is None:
            raise UserCancelled()
        return result
    except KeyboardInterrupt:
        raise UserCancelled()


def ask_password(message: str) -> str:
    """
    Ask for password/API key with hidden input.

    Args:
        message: Prompt message

    Returns:
        Password/Key input

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        result = questionary.password(message).ask()
        if result is None:
            raise UserCancelled()
        return result
    except KeyboardInterrupt:
        raise UserCancelled()


def choose_from_list(
    message: str,
    choices: List[str],
    allow_multiple: bool = False,
    default: Optional[str] = None,
    include_cancel: bool = True,
) -> Union[str, List[str], None]:
    """
    Let user choose from a list with arrow key navigation.

    Args:
        message: Prompt message
        choices: List of choices
        allow_multiple: Whether to allow multiple selections
        default: Default selection (for single selection)
        include_cancel: Whether to include a cancel option

    Returns:
        Selected choice(s) or None if cancelled

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        if allow_multiple:
            result = questionary.checkbox(message, choices=choices, qmark="?").ask()
            if result is None:
                raise UserCancelled()
            return result
        else:
            # Add cancel option for single select
            display_choices = list(choices)
            if include_cancel:
                display_choices.append("[X] Cancel")

            result = questionary.select(
                message, choices=display_choices, default=default, qmark="?"
            ).ask()

            if result is None or result == "[X] Cancel":
                raise UserCancelled()
            return result
    except KeyboardInterrupt:
        raise UserCancelled()


def choose_from_list_searchable(
    message: str,
    choices: List[str],
    allow_multiple: bool = False,
    search_placeholder: str = "models",
) -> Union[str, List[str], None]:
    """
    Let user search/filter a list in real-time as they type.

    Shows a text field at the top for searching, with a scrollable list below
    that filters in real-time as the user types. The user can navigate with
    arrow keys and select items.

    Args:
        message: Prompt message for the selection
        choices: List of choices to search through
        allow_multiple: Whether to allow multiple selections
        search_placeholder: Placeholder text describing what is being searched

    Returns:
        Selected choice(s) or None if cancelled

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    if not choices:
        display_warning("No choices available")
        raise UserCancelled()

    # If list is small, skip search and go straight to selection
    if len(choices) <= 20:
        return choose_from_list(message, choices, allow_multiple=allow_multiple)

    try:
        # State for filtering and selection
        search_buffer = Buffer()
        current_index = [0]  # Use list to allow mutation in nested functions
        selected_items = set()
        filtered_choices = [choices.copy()]  # Use list to allow mutation
        result = [None]  # Store result
        cancelled = [False]

        def get_filtered():
            """Get filtered choices based on search text."""
            search_text = search_buffer.text.strip().lower()
            if not search_text:
                return choices.copy()
            return [c for c in choices if search_text in c.lower()]

        def update_filter():
            """Update filtered list and reset index if needed."""
            filtered_choices[0] = get_filtered()
            if current_index[0] >= len(filtered_choices[0]):
                current_index[0] = max(0, len(filtered_choices[0]) - 1)

        def get_list_text():
            """Generate the formatted text for the list display."""
            update_filter()
            lines = []
            fc = filtered_choices[0]

            if not fc:
                return FormattedText([("class:warning", "  No matches found")])

            # Show up to 15 items around current index
            max_visible = 15
            start = max(0, current_index[0] - max_visible // 2)
            end = min(len(fc), start + max_visible)
            if end - start < max_visible and start > 0:
                start = max(0, end - max_visible)

            for i in range(start, end):
                item = fc[i]
                is_selected = item in selected_items
                is_current = i == current_index[0]

                # Build prefix
                if allow_multiple:
                    checkbox = "[*] " if is_selected else "[ ] "
                else:
                    checkbox = ""

                pointer = "> " if is_current else "  "

                # Style based on state
                if is_current and is_selected:
                    style = "class:selected-current"
                    line_text = f"{pointer}{checkbox}{item}"
                    lines.append((style, line_text))
                elif is_current:
                    style = "class:current"
                    line_text = f"{pointer}{checkbox}{item}"
                    lines.append((style, line_text))
                elif is_selected:
                    style = "class:selected"
                    line_text = f"{pointer}{checkbox}{item}"
                    lines.append((style, line_text))
                else:
                    line_text = f"{pointer}{checkbox}{item}"
                    lines.append(("", line_text))

                lines.append(("", "\n"))

            # Add scroll indicator if needed
            if start > 0:
                lines.insert(
                    0, ("class:scroll-indicator", f"  ... {start} more above ...\n")
                )
            if end < len(fc):
                lines.append(
                    ("class:scroll-indicator", f"  ... {len(fc) - end} more below ...")
                )

            return FormattedText(lines)

        def get_status_text():
            """Generate status line text."""
            fc = filtered_choices[0]
            search_text = search_buffer.text.strip()

            if search_text:
                status = f"Showing {len(fc)} of {len(choices)} {search_placeholder}"
            else:
                status = f"Showing all {len(choices)} {search_placeholder}"

            if allow_multiple and selected_items:
                status += f" | {len(selected_items)} selected"

            return status

        # Key bindings
        kb = KeyBindings()

        @kb.add("c-c")
        @kb.add("escape")
        def handle_cancel(event):
            cancelled[0] = True
            event.app.exit()

        @kb.add("enter")
        def handle_enter(event):
            fc = filtered_choices[0]
            if not fc:
                return

            if allow_multiple:
                # Return all selected items
                result[0] = list(selected_items)
            else:
                # Return current item
                if 0 <= current_index[0] < len(fc):
                    result[0] = fc[current_index[0]]
            event.app.exit()

        @kb.add("up")
        def handle_up(event):
            if current_index[0] > 0:
                current_index[0] -= 1

        @kb.add("down")
        def handle_down(event):
            fc = filtered_choices[0]
            if current_index[0] < len(fc) - 1:
                current_index[0] += 1

        @kb.add("space")
        def handle_space(event):
            if not allow_multiple:
                return
            fc = filtered_choices[0]
            if 0 <= current_index[0] < len(fc):
                item = fc[current_index[0]]
                if item in selected_items:
                    selected_items.remove(item)
                else:
                    selected_items.add(item)

        @kb.add("tab")
        def handle_tab(event):
            # Move focus or select
            if allow_multiple:
                handle_space(event)
            handle_down(event)

        # Create layout
        header_text = f"{message}\n"
        if allow_multiple:
            header_text += "Type to filter | Up/Down to navigate | Space to select | Enter to confirm | Esc to cancel"
        else:
            header_text += (
                "Type to filter | Up/Down to navigate | Enter to select | Esc to cancel"
            )

        search_window = Window(
            BufferControl(buffer=search_buffer),
            height=1,
        )

        list_window = Window(
            FormattedTextControl(text=get_list_text),
            height=17,  # Show ~15 items + scroll indicators
        )

        status_window = Window(
            FormattedTextControl(text=get_status_text),
            height=1,
        )

        layout = Layout(
            HSplit(
                [
                    Window(FormattedTextControl(text=header_text), height=2),
                    Window(FormattedTextControl(text="Search: "), height=1),
                    search_window,
                    Window(FormattedTextControl(text="-" * 50), height=1),
                    list_window,
                    Window(FormattedTextControl(text="-" * 50), height=1),
                    status_window,
                ]
            )
        )

        # Custom style
        style = questionary.Style(
            [
                ("current", "reverse bold"),
                ("selected", "fg:green"),
                ("selected-current", "fg:green reverse bold"),
                ("scroll-indicator", "fg:gray italic"),
                ("warning", "fg:yellow"),
            ]
        )

        app = Application(
            layout=layout,
            key_bindings=kb,
            full_screen=False,
            style=style,
        )

        # Focus on search buffer
        app.layout.focus(search_window)

        # Run the app
        app.run()

        if cancelled[0]:
            raise UserCancelled()

        if result[0] is None:
            if allow_multiple:
                return []
            raise UserCancelled()

        return result[0]

    except KeyboardInterrupt:
        raise UserCancelled()


def display_existing_items(
    title: str,
    items: List[Dict],
    censor_fields: Optional[List[str]] = None,
    key_field: str = "name",
) -> None:
    """
    Display existing items with optional field censorship.

    Args:
        title: Section title
        items: List of items to display
        censor_fields: Fields to censor (show last 4 chars)
        key_field: Field to use as the item name
    """
    print(f"\n{title}:")

    if not items:
        print("  No items configured")
        return

    censor_fields = censor_fields or []

    for item in items:
        name = item.get(key_field, "Unnamed")
        print(f"  • {name}")

        # Display additional fields with censorship
        for field in censor_fields:
            value = item.get(field, "")
            if value:
                censored = censor_string(value)
                print(f"    {field}: {censored}")


def censor_string(value: str, visible_chars: int = 4) -> str:
    """
    Censor a string, showing only the last N characters.

    Args:
        value: String to censor
        visible_chars: Number of characters to show at the end

    Returns:
        Censored string
    """
    if not value:
        return ""

    if len(value) <= visible_chars:
        # If string is too short, show all
        return value

    return "*" * (len(value) - visible_chars) + value[-visible_chars:]


def ask_batch_addition(item_type: str) -> bool:
    """
    Ask if user wants to add another item.

    Args:
        item_type: Type of item (e.g., "provider", "model", "API key")

    Returns:
        True if user wants to add another

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        return ask_yes_no(f"Add another {item_type}?", default=True)
    except UserCancelled:
        # For batch addition, Ctrl+C means "no, stop adding"
        return False


def display_success(message: str) -> None:
    """Display success message with ASCII-safe formatting."""
    symbol = "[OK]" if sys.platform == "win32" else "✓"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.GREEN, bold=True))


def display_error(message: str) -> None:
    """Display error message with ASCII-safe formatting."""
    symbol = "[ERROR]" if sys.platform == "win32" else "✗"
    typer.echo(
        typer.style(f"{symbol} {message}", fg=typer.colors.RED, bold=True), err=True
    )


def display_warning(message: str) -> None:
    """Display warning message with ASCII-safe formatting."""
    symbol = "[WARNING]" if sys.platform == "win32" else "⚠"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.YELLOW, bold=True))


def display_info(message: str) -> None:
    """Display info message with ASCII-safe formatting."""
    symbol = "[INFO]" if sys.platform == "win32" else "ℹ"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.BLUE))


def display_header(title: str, width: int = 60) -> None:
    """
    Display a section header.

    Args:
        title: Header title
        width: Width of the header line
    """
    print("\n" + "=" * width)
    print(title)
    print("=" * width)


def confirm_action(
    action: str, details: Optional[str] = None, default: bool = True
) -> bool:
    """
    Ask for confirmation before performing an action.

    Args:
        action: Description of the action to be performed
        details: Additional details about the action
        default: Default selection

    Returns:
        True if user confirms

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    if details:
        print(f"\n{action}")
        print(f"Details: {details}")
    else:
        print(f"\n{action}")

    return ask_yes_no("Proceed?", default=default)


def get_number_input(
    message: str,
    min_val: Optional[int] = None,
    max_val: Optional[int] = None,
    default: Optional[int] = None,
) -> Optional[int]:
    """
    Get a number input with validation.

    Args:
        message: Prompt message
        min_val: Minimum allowed value
        max_val: Maximum allowed value
        default: Default value

    Returns:
        Validated number or None

    Raises:
        UserCancelled: If user presses Ctrl+C
    """

    def validate_number(value: str) -> Optional[str]:
        if not value:
            if default is not None:
                return None
            return "This field is required"

        try:
            num = int(value)
            if min_val is not None and num < min_val:
                return f"Value must be at least {min_val}"
            if max_val is not None and num > max_val:
                return f"Value must be at most {max_val}"
            return None
        except ValueError:
            return "Please enter a valid integer"

    result = ask_text(
        message,
        default=str(default) if default is not None else "",
        validator=validate_number,
    )

    if result is None or result == "":
        if default is not None:
            return default
        return None

    return int(result)


def pause_for_review() -> None:
    """Pause execution and wait for user to press Enter."""
    print("\n" + "-" * 60)
    try:
        input("Press Enter to continue (Ctrl+C to cancel)...")
    except (EOFError, KeyboardInterrupt):
        print()
        raise UserCancelled()


def safe_select(
    message: str,
    choices: List[str],
    default: Optional[str] = None,
) -> str:
    """
    Wrapper for questionary.select with proper Ctrl+C handling.

    Args:
        message: Prompt message
        choices: List of choices
        default: Default selection

    Returns:
        Selected choice

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        result = questionary.select(
            message, choices=choices, default=default, qmark="?"
        ).ask()

        if result is None:
            raise UserCancelled()
        return result
    except KeyboardInterrupt:
        raise UserCancelled()


def safe_input(prompt: str = "") -> str:
    """
    Safe input that handles Ctrl+C gracefully.

    Args:
        prompt: Input prompt

    Returns:
        User input string

    Raises:
        UserCancelled: If user presses Ctrl+C
    """
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        print()
        raise UserCancelled()


# Wizard-specific display functions
def display_welcome_header(title: str) -> None:
    """
    Display stylized welcome header for the setup wizard.

    Args:
        title: Welcome message title
    """
    print("\n" + "=" * 70)
    print(f"{' '.join(title.center(68).split())}")
    print("=" * 70)


def display_step_header(step_name: str, step_number: int, total_steps: int) -> None:
    """
    Display step header with numbering for the setup wizard.

    Args:
        step_name: Name of the current step
        step_number: Current step number (1-based)
        total_steps: Total number of steps
    """
    print(f"\nStep {step_number} of {total_steps}: {step_name}")
    print("-" * len(f"Step {step_number} of {total_steps}: {step_name}"))


def display_completion_summary(completed_steps: List[str], total_steps: int) -> None:
    """
    Display summary of completed steps in the wizard.

    Args:
        completed_steps: List of completed step names
        total_steps: Total number of steps
    """
    print("\n" + "=" * 50)
    print("Setup Progress Summary")
    print("=" * 50)

    if not completed_steps:
        print("No steps completed yet.")
    else:
        print(f"Completed steps ({len(completed_steps)}/{total_steps}):")
        for step in completed_steps:
            print(f"  ✓ {step}")

    print(f"\nOverall progress: {len(completed_steps)}/{total_steps} steps completed")


def display_wizard_section_header(title: str, description: str = "") -> None:
    """
    Display a section header within a wizard step.

    Args:
        title: Section title
        description: Optional description
    """
    print(f"\n{'─' * 40}")
    print(f"{title}")
    if description:
        print(f"  {description}")
    print(f"{'─' * 40}")


def display_setup_tips(tips: List[str]) -> None:
    """
    Display helpful tips for the current setup step.

    Args:
        tips: List of tip messages
    """
    if tips:
        print("\n💡 Tips:")
        for i, tip in enumerate(tips, 1):
            print(f"  {i}. {tip}")


def display_step_prerequisites(prerequisites: List[str]) -> None:
    """
    Display prerequisites for the current step.

    Args:
        prerequisites: List of prerequisite descriptions
    """
    if prerequisites:
        print("\n📋 Prerequisites:")
        for prereq in prerequisites:
            print(f"  • {prereq}")


def display_next_actions(actions: List[str]) -> None:
    """
    Display next possible actions for the user.

    Args:
        actions: List of action descriptions
    """
    print("\n🔄 Next Actions:")
    for i, action in enumerate(actions, 1):
        print(f"  {i}. {action}")


def display_wizard_footer(message: str = "") -> None:
    """
    Display a footer message for wizard sections.

    Args:
        message: Footer message
    """
    if message:
        print(f"\n{message}")
    print("\n" + "─" * 70)
