"""
Unified setup wizard for Model-Proxy configuration.

Provides a guided experience for setting up providers, models, and API keys.
"""

from pathlib import Path

from app.cli.config_manager import ConfigManager
from app.cli.interactive import (
    display_header,
    display_success,
    display_error,
    display_info,
    display_warning,
    ask_yes_no,
    choose_from_list,
    handle_user_cancelled,
    UserCancelled,
)
from app.cli.wizard_utils import (
    get_setup_status,
    should_skip_step,
    create_progress_bar,
    display_setup_status,
    validate_prerequisites,
    save_progress_to_file,
    load_progress_from_file,
    clear_progress_file,
    get_step_name,
    format_model_config_summary,
)


class SetupWizard:
    """Main wizard coordinator class."""

    def __init__(self):
        self.config_manager = ConfigManager()
        self.completed_steps = []
        self.total_steps = 3
        self.setup_type = "guided"  # guided, custom, quick
        self.current_step = 1
        self.progress_file = ".model-proxy-setup-progress"

    def run(self) -> None:
        """Run the complete setup wizard."""
        try:
            # Load progress if resuming
            if Path(self.progress_file).exists():
                self._handle_resume()

            # Show welcome and setup options
            self.show_welcome()

            # Main wizard loop
            while self.current_step <= self.total_steps:
                step_name = self._get_step_name(self.current_step)

                if step_name == "providers" and should_skip_step(
                    "providers", self.config_manager
                ):
                    self._complete_step("providers")
                    self.current_step += 1
                    continue

                elif step_name == "models" and should_skip_step(
                    "models", self.config_manager
                ):
                    self._complete_step("models")
                    self.current_step += 1
                    continue

                elif step_name == "api_keys" and should_skip_step(
                    "api_keys", self.config_manager
                ):
                    self._complete_step("api_keys")
                    self.current_step += 1
                    continue

                # Execute the step
                step_completed = self._execute_step(step_name)

                if step_completed:
                    self._complete_step(step_name)
                    self.current_step += 1
                else:
                    # User cancelled this step but not the whole wizard
                    if not ask_yes_no("Continue with next step?", default=True):
                        self._handle_partial_completion()
                        return

            # Show completion summary
            self.generate_summary()

            # Clean up progress file
            clear_progress_file(self.progress_file)

        except UserCancelled:
            handle_user_cancelled()
        except KeyboardInterrupt:
            print()
            display_warning("Setup wizard cancelled")
            if ask_yes_no("Save progress for later?", default=True):
                self.save_progress()
            raise
        except Exception as e:
            display_error(f"Setup wizard failed: {e}")
            self.save_progress()
            raise

    def _handle_resume(self) -> None:
        """Handle resuming from saved progress."""
        progress = load_progress_from_file(self.progress_file)
        if progress:
            self.completed_steps = progress.get("completed_steps", [])
            self.current_step = progress.get("current_step", 1)
            self.setup_type = progress.get("setup_type", "guided")

            display_info(f"Resuming from step {self.current_step}")
            display_setup_status(self.config_manager)

    def _get_step_name(self, step_number: int) -> str:
        """Get step name from step number."""
        step_names = {1: "providers", 2: "models", 3: "api_keys"}
        return step_names.get(step_number, "unknown")

    def _execute_step(self, step_name: str) -> bool:
        """Execute a specific setup step."""
        step_number = self._get_step_number(step_name)

        display_header(f"Step {step_number}: {get_step_name(step_name)}")
        self.show_progress(step_number)

        # Check prerequisites
        prerequisites_met, missing_prerequisites = validate_prerequisites(
            step_name, self.config_manager
        )
        if not prerequisites_met:
            print("Prerequisites not met:")
            for missing in missing_prerequisites:
                print(f"  • {missing}")

            if not ask_yes_no("Continue anyway?", default=False):
                return False

        # Execute the appropriate step
        if step_name == "providers":
            return self.run_provider_setup()
        elif step_name == "models":
            return self.run_model_setup()
        elif step_name == "api_keys":
            return self.run_api_key_setup()

        return False

    def _get_step_number(self, step_name: str) -> int:
        """Get step number from step name."""
        step_numbers = {"providers": 1, "models": 2, "api_keys": 3}
        return step_numbers.get(step_name, 0)

    def _complete_step(self, step_name: str) -> None:
        """Mark a step as completed."""
        if step_name not in self.completed_steps:
            self.completed_steps.append(step_name)
            display_success(f"✓ {get_step_name(step_name)} completed")
            self.save_progress()

    def _handle_partial_completion(self) -> None:
        """Handle when user cancels partway through the wizard."""
        if self.completed_steps:
            display_info(f"\nCompleted: {', '.join(self.completed_steps)}")
            if ask_yes_no("Save progress?", default=True):
                self.save_progress()
        else:
            clear_progress_file(self.progress_file)

    def save_progress(self) -> None:
        """Save wizard progress to file."""
        progress = {
            "completed_steps": self.completed_steps,
            "current_step": self.current_step,
            "setup_type": self.setup_type,
            "total_steps": self.total_steps,
        }
        save_progress_to_file(progress, self.progress_file)

    def show_welcome(self) -> None:
        """Display welcome message and setup options."""
        display_header("Model-Proxy Setup Wizard")
        print("Welcome to Model-Proxy! This wizard will guide you through setting up")
        print("your multi-provider LLM inference proxy.")
        print()

        # Show current status
        display_setup_status(self.config_manager)

        print("\n" + "=" * 60)

        if not self.completed_steps:
            # First run - choose setup type
            print("Choose your setup experience:")
            print()

            options = [
                "guided - Recommended: Follow Provider → Models → Keys order",
                "custom - Choose specific sections to configure",
                "quick - Only essential configuration for basic functionality",
            ]

            choice = choose_from_list("Select setup type:", options)

            if choice:
                # Extract the type from the choice (first word)
                self.setup_type = choice.split(" - ")[0]
            else:
                self.setup_type = "guided"

            print(f"\nSetup type: {self.setup_type}")
        else:
            print(f"Resuming {self.setup_type} setup...")
            print()

    def show_progress(self, current_step: int) -> None:
        """Display progress tracking."""
        print(f"Progress: {create_progress_bar(current_step, self.total_steps)}")
        print()

        # Show completed steps
        if self.completed_steps:
            print("Completed steps:")
            for step in self.completed_steps:
                print(f"  ✓ {get_step_name(step)}")
            print()

    def run_provider_setup(self) -> bool:
        """Execute provider setup with wizard UX."""
        try:
            # Import here to avoid circular dependencies
            from app.cli.providers import add_provider_interactive

            # Show guidance
            display_info(
                "This step helps you configure LLM providers like OpenAI, Anthropic, Gemini, etc."
            )
            print("You'll add at least one provider that Model-Proxy can connect to.")
            print()

            # Run the provider interactive function
            add_provider_interactive()

            return True

        except UserCancelled:
            # User cancelled provider setup
            if ask_yes_no("Skip provider setup for now?", default=False):
                return True  # Mark as completed so we can proceed
            else:
                raise  # Re-raise to cancel entire wizard
        except Exception as e:
            display_error(f"Provider setup failed: {e}")
            return ask_yes_no("Try again?", default=True)

    def run_model_setup(self) -> bool:
        """Execute model configuration with wizard UX."""
        try:
            from app.cli.models import add_model_interactive

            # Show guidance
            display_info(
                "This step helps you configure model routing and fallback chains."
            )
            print(
                "You'll connect logical model names to specific providers and models."
            )
            print("You can also set up fallback chains for reliability.")
            print()

            # Run the model interactive function
            add_model_interactive()

            return True

        except UserCancelled:
            if ask_yes_no("Skip model setup for now?", default=False):
                return True
            else:
                raise
        except Exception as e:
            display_error(f"Model setup failed: {e}")
            return ask_yes_no("Try again?", default=True)

    def run_api_key_setup(self) -> bool:
        """Execute API key management with wizard UX."""
        try:
            from app.cli.api_keys import add_api_key_interactive

            # Show guidance
            display_info("This step helps you add API keys for your providers.")
            print("Each provider needs at least one API key to function.")
            print("You can add multiple keys per provider for automatic fallback.")
            print()

            # Run the API key interactive function
            add_api_key_interactive()

            return True

        except UserCancelled:
            if ask_yes_no("Skip API key setup for now?", default=False):
                return True
            else:
                raise
        except Exception as e:
            display_error(f"API key setup failed: {e}")
            return ask_yes_no("Try again?", default=True)

    def generate_summary(self) -> None:
        """Generate setup summary report."""
        display_header("Setup Complete!")
        print()

        # Show what was configured
        print("Configuration Summary:")
        print("-" * 40)

        # Current status
        status = get_setup_status(self.config_manager)

        print(f"Providers: {status['providers_count']} configured")
        print(f"  • {status['enabled_providers']} enabled")

        print(f"Models: {status['models_count']} configured")

        print(f"API Keys: {status['api_keys_count']} configured")
        print(f"  • {status['providers_with_keys']} providers with keys")

        # Show model details if any
        if status["models_count"] > 0:
            models = self.config_manager.get_models()
            print("\nModel Configurations:")
            print(format_model_config_summary(list(models.values())))

        print("\n" + "=" * 60)

        # Next steps
        print("Next Steps:")
        print("1. Test your setup: model-proxy doctor")
        print("2. Start the server: model-proxy start")
        print("3. View available models: model-proxy config list")

        if status["recommendations"]:
            print("\nAdditional Recommendations:")
            for i, rec in enumerate(status["recommendations"], 1):
                print(f"  {i}. {rec}")

        print()
        display_success("Model-Proxy is ready to use!")
        print("Run 'model-proxy --help' for available commands.")
