# OpenCode Behavior Adjustment System (BAS) Plugin

This plugin enhances technical collaboration by injecting contextual behavioral reminders based on conversation content.

## Features

- **Contextual Awareness**: Detects conversation topics (Code Review, Architecture, Debugging, etc.) and applies relevant behavioral templates.
- **Adaptive Model Parameters**: Adjusts model temperature and other parameters based on the detected context.
- **Template Deduplication**: Resolves multiple matching contexts using priority-based deduplication.
- **Configurable Injection Rates**: Controls how often reminders are injected.
- **Detailed Logging**: Optional logging of injection events for analysis.

## Configuration

The plugin loads configuration from:

1. `~/.config/opencode/behavior-config.json` (User-level)
2. `.opencode/behavior-config.json` (Project-level)

Project-level configuration takes precedence.

### Example `behavior-config.json`

```json
{
  "enabled": true,
  "adaptiveMode": true,
  "logging": true,
  "contexts": {
    "default": {
      "template": "balanced",
      "injectionRate": 0.4,
      "priority": 1,
      "temperature": 0.3
    }
  },
  "templates": {
    "balanced": {
      "type": "behavior",
      "prompt": [
        "<system-reminder>",
        "Maintain technical peer stance. Evaluate before responding.",
        "</system-reminder>"
      ]
    }
  }
}
```

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["opencode-bas-plugin"]
}
```

## License

MIT
