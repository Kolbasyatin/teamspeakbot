export interface SaigaOptions {
    baseUrl: string;
    model?: string;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
}

export interface SaigaGenerateOptions {
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
    error?: {
        message?: string;
    } | string;
}

export class Saiga {
    private readonly endpoint: string;
    private readonly model: string;
    private readonly timeoutMs: number;
    private readonly temperature: number;
    private readonly maxTokens: number;
    private readonly systemPrompt: string;

    constructor(options: SaigaOptions) {
        this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
        this.model = options.model ?? "ilyagusev/saiga_nemo_12b";
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.temperature = options.temperature ?? 1;
        this.maxTokens = options.maxTokens ?? 160;
        this.systemPrompt = options.systemPrompt ?? [
            "Ты пишешь короткие абсурдные русские сообщения для игрового Telegram-канала.",
            "Мат разрешен.",
            "Не объясняй шутку.",
            "Не упоминай, что ты AI.",
        ].join(" ");
    }

    public async generateMessage(prompt: string, options: SaigaGenerateOptions = {}): Promise<string> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(this.endpoint, {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        {
                            role: "system",
                            content: options.systemPrompt ?? this.systemPrompt,
                        },
                        {
                            role: "user",
                            content: prompt,
                        },
                    ],
                    temperature: options.temperature ?? this.temperature,
                    max_tokens: options.maxTokens ?? this.maxTokens,
                }),
            });

            const data = await this.parseResponse(response);
            const content = data.choices?.[0]?.message?.content?.trim();

            if (!content) {
                throw new Error("Saiga returned an empty message");
            }

            return content;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async parseResponse(response: Response): Promise<ChatCompletionResponse> {
        const data = await response.json() as ChatCompletionResponse;

        if (!response.ok) {
            const message = typeof data.error === "string"
                ? data.error
                : data.error?.message ?? `HTTP ${response.status}`;

            throw new Error(`Saiga request failed: ${message}`);
        }

        return data;
    }
}
