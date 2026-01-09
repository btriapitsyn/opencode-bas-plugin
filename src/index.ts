import { promises as fs } from "fs";
import { join } from "path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

interface Template {
    type: string;
    prompt: string | string[];
}

interface ContextConfig {
    template: string;
    injectionRate: number;
    priority: number;
    temperature?: number;
    keywords?: string[];
    description?: string;
}

interface PluginConfig {
    enabled: boolean;
    adaptiveMode: boolean;
    logging: boolean;
    contexts: Record<string, ContextConfig>;
    templates: Record<string, Template>;
}

// LOGGING CONFIGURATION
const LOG_FILE_PATH = join(process.env.HOME || "", ".config/opencode/behavior-adjustment.log");

// LOGGING FUNCTION
async function logInjectionEvent(logData: any, loggingEnabled: boolean) {
    if (!loggingEnabled) return;

    try {
        const logEntry =
            JSON.stringify({
                timestamp: new Date().toISOString(),
                ...logData,
            }) + "\n";

        await fs.appendFile(LOG_FILE_PATH, logEntry);
    } catch (error: any) {
        console.warn("Behavior Adjustment Plugin: Failed to write log entry:", error.message);
    }
}

// Load configuration
async function loadConfig(): Promise<PluginConfig | null> {
    async function loadConfigFile(path: string) {
        try {
            const content = await fs.readFile(path, "utf8");
            return JSON.parse(content);
        } catch (e) {
            return null;
        }
    }

    let finalConfig: PluginConfig | null = null;

    const userConfigPaths = [join(process.env.HOME || "", ".config/opencode/behavior-config.json")];

    for (const path of userConfigPaths) {
        const config = await loadConfigFile(path);
        if (config) {
            finalConfig = config;
            break;
        }
    }

    const projectConfigPaths = [join(process.cwd(), ".opencode/behavior-config.json")];

    for (const path of projectConfigPaths) {
        const config = await loadConfigFile(path);
        if (config) {
            finalConfig = { ...finalConfig, ...config } as PluginConfig;
            break;
        }
    }

    if (!finalConfig) {
        console.log("Behavior Adjustment Plugin: No configuration file found. Plugin disabled.");
        return null;
    }

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

function detectContexts(message: string, config: PluginConfig) {
    if (!message) {
        return [{ name: "default", ...config.contexts.default }];
    }

    const lowerMessage = message.toLowerCase();
    const matchedContexts: (ContextConfig & { name: string })[] = [];

    for (const [contextName, contextConfig] of Object.entries(config.contexts)) {
        if (contextName === "default" || !contextConfig.keywords) {
            continue;
        }

        for (const keyword of contextConfig.keywords) {
            if (lowerMessage.includes(keyword.toLowerCase())) {
                matchedContexts.push({
                    name: contextName,
                    ...contextConfig,
                });
                break;
            }
        }
    }

    return matchedContexts.length > 0 ? matchedContexts : [{ name: "default", ...config.contexts.default }];
}

function resolveContexts(matchedContexts: (ContextConfig & { name: string })[], config: PluginConfig) {
    if (!matchedContexts.length) {
        const defaultContext = config.contexts.default;
        return {
            templates: [defaultContext.template],
            injectionRate: defaultContext.injectionRate,
            context: "default",
            temperature: defaultContext.temperature,
        };
    }

    const templatesByType = new Map<string, any>();

    matchedContexts.sort((a, b) => b.priority - a.priority);

    for (const ctx of matchedContexts) {
        const templateConfig = config.templates[ctx.template];
        if (!templateConfig) continue;

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

    let temperatureContext: any = null;
    let highestTempPriority = -1;

    for (const ctx of matchedContexts) {
        if (ctx.temperature !== undefined && ctx.priority > highestTempPriority) {
            temperatureContext = ctx;
            highestTempPriority = ctx.priority;
        }
    }

    const selectedTemplates: string[] = [];
    let highestRate = 0;
    const contextNames: string[] = [];

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

function generateReminder(resolved: any, config: PluginConfig) {
    if (!resolved.templates || resolved.templates.length === 0) {
        return null;
    }

    const reminders: string[] = [];

    for (const templateName of resolved.templates) {
        const templateConfig = config.templates[templateName];
        if (!templateConfig) continue;

        const prompt = Array.isArray(templateConfig.prompt) ? templateConfig.prompt.join("\n") : templateConfig.prompt;
        reminders.push(prompt);
    }

    if (reminders.length === 0) {
        return null;
    }

    if (reminders.length === 1) {
        return reminders[0].replace("{context}", resolved.context);
    }

    return reminders.join("\n\n").replace("{context}", resolved.context);
}

export const BehaviorAdjustmentPlugin: Plugin = async ({ client }) => {
    const config = await loadConfig();

    if (!config) {
        return {};
    }

    return {
        "chat.message": async (_, output: any) => {
            if (!config.enabled) return;

            if (!output.parts || !Array.isArray(output.parts)) {
                output.parts = [];
            }

            const alreadyInjected = output.parts.some((p: any) => p.synthetic && p.id?.startsWith("behavior-adj-"));
            if (alreadyInjected) return;

            let resolved: any;
            let messageText = "";
            if (config.adaptiveMode) {
                const textParts = output.parts.filter((p: any) => p.type === "text" && !p.synthetic);
                messageText = textParts.map((p: any) => p.text || "").join(" ");
                const matchedContexts = detectContexts(messageText, config);
                resolved = resolveContexts(matchedContexts, config);
            } else {
                const defaultContext = config.contexts.default;
                resolved = {
                    templates: [defaultContext.template],
                    injectionRate: defaultContext.injectionRate,
                    context: "default",
                    temperature: defaultContext.temperature,
                };
            }

            const shouldInject = Math.random() < resolved.injectionRate;
            let injectionText = null;

            if (shouldInject) {
                const reminder = generateReminder(resolved, config);

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

            if (config.logging) {
                const matchedContexts = config.adaptiveMode ? detectContexts(messageText, config) : [{ name: "default", ...config.contexts.default }];

                await logInjectionEvent(
                    {
                        sessionId: output.message.sessionID,
                        messageId: output.message.id,
                        userMessage: messageText,
                        detectedContexts: matchedContexts.map((ctx: any) => ctx.name),
                        resolvedContext: resolved.context,
                        injectionRate: resolved.injectionRate,
                        injectionOccurred: !!injectionText,
                        injectionText: injectionText,
                    },
                    config.logging,
                );
            }
        },
        "chat.params": async (_, output: any) => {
            if (!config.enabled || !config.adaptiveMode) return;

            if (!output.parts || !Array.isArray(output.parts)) {
                return;
            }

            const textParts = output.parts.filter((p: any) => p.type === "text" && !p.synthetic);
            const messageText = textParts.map((p: any) => p.text || "").join(" ");
            const matchedContexts = detectContexts(messageText, config);
            const resolved = resolveContexts(matchedContexts, config);

            if (resolved.temperature !== undefined) {
                output.temperature = resolved.temperature;
            }
        },
    };
};

export default BehaviorAdjustmentPlugin;
