/**
 * Behavior Adjustment Plugin
 *
 * Enhances technical collaboration by injecting contextual behavioral reminders
 * based on conversation content. Supports type-based template deduplication,
 * adaptive model parameter adjustment, and configurable injection frequencies.
 *
 * CONDITIONAL LOGGING: Logs behavioral adjustment events when logging is enabled
 */

import { promises as fs } from "fs";
import { join } from "path";

// LOGGING CONFIGURATION
const LOG_FILE_PATH = join(process.env.HOME || "", ".config/opencode/behavior-adjustment.log");

// LOGGING FUNCTION - only active when config.logging is true
async function logInjectionEvent(logData, loggingEnabled) {
    if (!loggingEnabled) return;

    try {
        const logEntry =
            JSON.stringify({
                timestamp: new Date().toISOString(),
                ...logData,
            }) + "\n";

        await fs.appendFile(LOG_FILE_PATH, logEntry);
    } catch (error) {
        console.warn("Behavior Adjustment Plugin: Failed to write log entry:", error.message);
    }
}

// Load configuration with project-level precedence over user-level settings
async function loadConfig() {
    // Helper to load and parse JSON configuration files
    async function loadConfigFile(path) {
        try {
            const content = await fs.readFile(path, "utf8");
            return JSON.parse(content);
        } catch (e) {
            return null; // File doesn't exist or can't be read
        }
    }

    let finalConfig = null;

    // 1. Load user-level config (base layer)
    const userConfigPaths = [join(process.env.HOME, ".config/opencode/behavior-config.json")];

    for (const path of userConfigPaths) {
        const config = await loadConfigFile(path);
        if (config) {
            finalConfig = config;
            break; // Use first found user config
        }
    }

    // 2. Load project-level config (takes precedence)
    const projectConfigPaths = [join(process.cwd(), ".opencode/behavior-config.json")];

    for (const path of projectConfigPaths) {
        const config = await loadConfigFile(path);
        if (config) {
            finalConfig = { ...finalConfig, ...config };
            break; // Use first found project config
        }
    }

    // Return null if no config found - caller will handle gracefully
    if (!finalConfig) {
        console.log("Behavior Adjustment Plugin: No configuration file found. Plugin disabled.");
        return null;
    }

    // Validate that required structure exists
    if (!finalConfig.contexts?.default) {
        console.log("Behavior Adjustment Plugin: Invalid configuration - missing 'contexts.default'. Plugin disabled.");
        return null;
    }

    if (!finalConfig.templates || Object.keys(finalConfig.templates).length === 0) {
        console.log("Behavior Adjustment Plugin: Invalid configuration - no templates defined. Plugin disabled.");
        return null;
    }

    return finalConfig;
}

// Scan message content for context keywords and return matching contexts
function detectContexts(message, config) {
    if (!message) {
        return [{ name: "default", ...config.contexts.default }];
    }

    const lowerMessage = message.toLowerCase();
    const matchedContexts = [];

    // Check each defined context for keyword matches (excluding default fallback)
    for (const [contextName, contextConfig] of Object.entries(config.contexts)) {
        if (contextName === "default" || !contextConfig.keywords) {
            continue;
        }

        // Test each keyword - if any match, include this context
        for (const keyword of contextConfig.keywords) {
            if (lowerMessage.includes(keyword.toLowerCase())) {
                matchedContexts.push({
                    name: contextName,
                    ...contextConfig,
                });
                break; // Each context added only once per message
            }
        }
    }

    return matchedContexts.length > 0 ? matchedContexts : [{ name: "default", ...config.contexts.default }];
}

// Apply type-based deduplication to resolve final template set
// Templates with same 'type' field are mutually exclusive (highest priority wins)
// Different types can combine (e.g., behavior + domain-specific standards)
function resolveContexts(matchedContexts, config) {
    if (!matchedContexts.length) {
        // This shouldn't happen since detectContexts always returns default context
        const defaultContext = config.contexts.default;
        return {
            templates: [defaultContext.template],
            injectionRate: defaultContext.injectionRate,
            context: "default",
            temperature: defaultContext.temperature,
        };
    }

    const templatesByType = new Map(); // type -> {template, priority, injectionRate, context}

    // Process contexts in priority order (highest first)
    // All contexts must have priority defined for proper ordering
    matchedContexts.sort((a, b) => b.priority - a.priority);

    for (const ctx of matchedContexts) {
        const templateConfig = config.templates[ctx.template];
        if (!templateConfig) continue;

        // Only keep the highest priority template for each type
        const existing = templatesByType.get(templateConfig.type);
        if (!existing || ctx.priority > existing.priority) {
            templatesByType.set(templateConfig.type, {
                template: ctx.template,
                priority: ctx.priority,
                injectionRate: ctx.injectionRate,
                context: ctx.name,
            });
        }
    }

    // Find highest priority context for temperature setting
    let temperatureContext = null;
    let highestTempPriority = -1;

    for (const ctx of matchedContexts) {
        if (ctx.temperature !== undefined && ctx.priority > highestTempPriority) {
            temperatureContext = ctx;
            highestTempPriority = ctx.priority;
        }
    }

    // Build final template selection with highest injection rate
    const selectedTemplates = [];
    let highestRate = 0;
    const contextNames = [];

    for (const selection of templatesByType.values()) {
        selectedTemplates.push(selection.template);
        if (selection.injectionRate > highestRate) {
            highestRate = selection.injectionRate;
        }
        contextNames.push(selection.context);
    }

    return {
        templates: selectedTemplates,
        injectionRate: highestRate,
        context: contextNames.join("+"),
        temperature: temperatureContext?.temperature ?? config.contexts.default.temperature,
    };
}

// Build final behavioral reminder from resolved template set
function generateReminder(resolved, config) {
    if (!resolved.templates || resolved.templates.length === 0) {
        // No templates resolved - skip injection
        return null;
    }

    const reminders = [];

    for (const templateName of resolved.templates) {
        const templateConfig = config.templates[templateName];
        if (!templateConfig) continue;

        const prompt = Array.isArray(templateConfig.prompt) ? templateConfig.prompt.join("\n") : templateConfig.prompt;
        reminders.push(prompt);
    }

    if (reminders.length === 0) {
        // No valid templates found - skip injection
        return null;
    }

    // Single template: return as-is with context substitution
    if (reminders.length === 1) {
        return reminders[0].replace("{context}", resolved.context);
    }

    // Multiple templates: concatenate with context substitution
    return reminders.join("\n\n").replace("{context}", resolved.context);
}

export const BehaviorAdjustment = async () => {
    const config = await loadConfig();

    // If no config found or invalid config, return disabled plugin
    if (!config) {
        return {
            "chat.message": async () => {}, // No-op
            "chat.params": async () => {}, // No-op
        };
    }

    return {
        /**
         * Main injection logic: analyze message content and conditionally inject behavioral reminders
         */
        "chat.message": async (_, output) => {
            if (!config.enabled) return;

            // Safety check for output.parts
            if (!output.parts || !Array.isArray(output.parts)) {
                output.parts = [];
            }

            // Prevent duplicate injections into the same message output
            const alreadyInjected = output.parts.some((p) => p.synthetic && p.id?.startsWith("behavior-adj-"));
            if (alreadyInjected) return;

            // Context detection and template resolution
            let resolved;
            let messageText = "";
            if (config.adaptiveMode) {
                // Extract user message text for analysis
                const textParts = output.parts.filter((p) => p.type === "text" && !p.synthetic);
                messageText = textParts.map((p) => p.text || "").join(" ");
                const matchedContexts = detectContexts(messageText, config);
                resolved = resolveContexts(matchedContexts, config);
            } else {
                // Fixed behavior when adaptive mode disabled - use default context
                const defaultContext = config.contexts.default;
                resolved = {
                    templates: [defaultContext.template],
                    injectionRate: defaultContext.injectionRate,
                    context: "default",
                    temperature: defaultContext.temperature,
                };
            }

            // Probabilistic injection based on context-specific rates
            const shouldInject = Math.random() < resolved.injectionRate;

            let injectionText = null;

            if (shouldInject) {
                const reminder = generateReminder(resolved, config);

                // Only inject if reminder was successfully generated
                if (reminder) {
                    injectionText = reminder;

                    output.parts.unshift({
                        id: `behavior-adj-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                        type: "text",
                        text: reminder,
                        synthetic: true,
                        messageID: output.message.id,
                        sessionID: output.message.sessionID,
                    });
                }
            }

            // CONDITIONAL LOGGING - only logs when config.logging is true
            if (config.logging) {
                const matchedContexts = config.adaptiveMode ? detectContexts(messageText, config) : [{ name: "default", ...config.contexts.default }];

                await logInjectionEvent(
                    {
                        sessionId: output.message.sessionID,
                        messageId: output.message.id,
                        userMessage: messageText,
                        detectedContexts: matchedContexts.map((ctx) => ctx.name),
                        resolvedContext: resolved.context,
                        injectionRate: resolved.injectionRate,
                        injectionOccurred: !!injectionText,
                        injectionText: injectionText,
                    },
                    config.logging,
                );
            }
        },

        /**
         * Apply context-specific model parameters (temperature, etc.)
         */
        "chat.params": async (_, output) => {
            if (!config.enabled || !config.adaptiveMode) return;

            // Safety check for output.parts
            if (!output.parts || !Array.isArray(output.parts)) {
                return; // Skip parameter adjustment if no parts available
            }

            // Detect contexts for temperature resolution
            const textParts = output.parts.filter((p) => p.type === "text" && !p.synthetic);
            const messageText = textParts.map((p) => p.text || "").join(" ");
            const matchedContexts = detectContexts(messageText, config);
            const resolved = resolveContexts(matchedContexts, config);

            // Apply temperature from highest priority context
            if (resolved.temperature !== undefined) {
                output.temperature = resolved.temperature;
            }
        },
    };
};
