"""
Provider Registry - Centralized factory for creating and managing provider instances.

This module provides a registry pattern for provider classes, allowing:
- Dynamic provider instantiation based on provider name
- Route-specific configuration injection (API key, base URL)
- Clean separation between provider types and their instantiation
"""

from typing import Dict, Optional, Type

from app.providers.base import BaseProvider


class ProviderRegistry:
    """
    Registry for provider classes and instance creation.

    This registry maps provider names to their implementation classes
    and provides factory methods for creating configured provider instances.
    """

    # Mapping of provider names to provider classes
    # Lazy-loaded to avoid circular imports
    _provider_classes: Optional[Dict[str, Type[BaseProvider]]] = None

    @classmethod
    def _get_provider_classes(cls) -> Dict[str, Type[BaseProvider]]:
        """
        Get the provider class mapping, initializing lazily if needed.

        Returns:
            Dictionary mapping provider names to provider classes
        """
        if cls._provider_classes is None:
            # Import here to avoid circular imports
            from app.providers.anthropic_provider import AnthropicProvider
            from app.providers.azure_provider import AzureProvider
            from app.providers.gemini_openai_provider import GeminiOpenAIProvider
            from app.providers.openai_provider import OpenAIProvider

            cls._provider_classes = {
                # OpenAI-compatible providers
                "openai": OpenAIProvider,
                "openrouter": OpenAIProvider,
                "nahcrof": OpenAIProvider,
                "groq": OpenAIProvider,
                "cerebras": OpenAIProvider,
                "llama": OpenAIProvider,
                "mistral": OpenAIProvider,
                "cloudflare": OpenAIProvider,
                "chutes": OpenAIProvider,
                "longcat": OpenAIProvider,
                # Gemini uses dedicated OpenAI-compatible provider
                "gemini": GeminiOpenAIProvider,
                # Anthropic provider
                "anthropic": AnthropicProvider,
                # Azure-based providers
                "github": AzureProvider,
                "azure": AzureProvider,
            }

        return cls._provider_classes

    @classmethod
    def get_provider_class(cls, provider_name: str) -> Type[BaseProvider]:
        """
        Get the provider class for a given provider name.

        Args:
            provider_name: Name of the provider (e.g., "openai", "anthropic")

        Returns:
            The provider class

        Raises:
            ValueError: If provider name is not recognized
        """
        provider_classes = cls._get_provider_classes()
        provider_class = provider_classes.get(provider_name)

        if provider_class is None:
            available = ", ".join(sorted(provider_classes.keys()))
            raise ValueError(
                f"Unknown provider: '{provider_name}'. Available providers: {available}"
            )

        return provider_class

    @classmethod
    def create_provider(
        cls,
        provider_name: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> BaseProvider:
        """
        Create a new provider instance with optional route configuration.

        This is the primary factory method for creating providers.
        The returned provider will have route-specific API key and base URL
        configured if provided.

        Args:
            provider_name: Name of the provider (e.g., "openai", "anthropic")
            api_key: Optional API key to use for this provider instance
            base_url: Optional base URL override for this provider instance

        Returns:
            Configured provider instance

        Raises:
            ValueError: If provider name is not recognized
        """
        provider_class = cls.get_provider_class(provider_name)

        # Create the provider instance
        # Some providers don't take provider_name in constructor
        from app.providers.anthropic_provider import AnthropicProvider
        from app.providers.gemini_openai_provider import GeminiOpenAIProvider

        if provider_class in (AnthropicProvider, GeminiOpenAIProvider):
            provider = provider_class()
        else:
            provider = provider_class(provider_name)

        # Inject route-specific configuration if provided
        if api_key is not None or base_url is not None:
            provider.set_route_config(api_key=api_key, base_url=base_url)

        return provider

    @classmethod
    def get_provider_for_route(
        cls,
        provider_name: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> BaseProvider:
        """
        Create a provider instance configured for a specific route.

        This is an alias for create_provider() with a more descriptive name
        for use in the fallback routing context.

        Args:
            provider_name: Name of the provider
            api_key: API key to use for this route
            base_url: Optional base URL override

        Returns:
            Configured provider instance
        """
        return cls.create_provider(
            provider_name=provider_name,
            api_key=api_key,
            base_url=base_url,
        )

    @classmethod
    def is_valid_provider(cls, provider_name: str) -> bool:
        """
        Check if a provider name is valid/registered.

        Args:
            provider_name: Name to check

        Returns:
            True if the provider is registered, False otherwise
        """
        return provider_name in cls._get_provider_classes()

    @classmethod
    def get_available_providers(cls) -> list:
        """
        Get list of all registered provider names.

        Returns:
            Sorted list of provider names
        """
        return sorted(cls._get_provider_classes().keys())

    @classmethod
    def register_provider(
        cls, provider_name: str, provider_class: Type[BaseProvider]
    ) -> None:
        """
        Register a new provider class.

        This allows runtime registration of custom providers.

        Args:
            provider_name: Name to register the provider under
            provider_class: The provider class to register
        """
        provider_classes = cls._get_provider_classes()
        provider_classes[provider_name] = provider_class

    @classmethod
    def unregister_provider(cls, provider_name: str) -> bool:
        """
        Unregister a provider.

        Args:
            provider_name: Name of the provider to unregister

        Returns:
            True if provider was unregistered, False if it wasn't registered
        """
        provider_classes = cls._get_provider_classes()
        if provider_name in provider_classes:
            del provider_classes[provider_name]
            return True
        return False


# Convenience functions for module-level access


def get_provider(
    provider_name: str,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> BaseProvider:
    """
    Get a configured provider instance.

    Convenience function that delegates to ProviderRegistry.create_provider().

    Args:
        provider_name: Name of the provider
        api_key: Optional API key for this instance
        base_url: Optional base URL override

    Returns:
        Configured provider instance
    """
    return ProviderRegistry.create_provider(
        provider_name=provider_name,
        api_key=api_key,
        base_url=base_url,
    )


def is_valid_provider(provider_name: str) -> bool:
    """
    Check if a provider name is valid.

    Args:
        provider_name: Name to check

    Returns:
        True if valid, False otherwise
    """
    return ProviderRegistry.is_valid_provider(provider_name)


def get_available_providers() -> list:
    """
    Get list of all available provider names.

    Returns:
        Sorted list of provider names
    """
    return ProviderRegistry.get_available_providers()
