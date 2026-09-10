import { access } from "node:fs/promises";

const command = process.argv[2] ?? "probe";
const args = process.argv.slice(3);

try {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    emit({ ok: false, kind: "unsupported-platform", message: "mlx-ts requires Apple Silicon macOS" });
    process.exit(1);
  }

  const mlx = await import("@nielspeter/mlx-ts");
  const base = {
    backend: mlx.backend.name,
    runtime: mlx.backend.version,
    library: mlx.LIBMLXC,
  };

  if (command === "probe") {
    const scalar = mlx.scalar(2);
    const handle = scalar.h;
    let value;
    try {
      value = scalar.itemF();
    } finally {
      scalar.free();
    }
    emit({ ok: value === 2, ...base, handle, value });
    if (value !== 2) process.exitCode = 1;
  } else if (command === "generate") {
    const repo = option(args, "--model") ?? "mlx-community/Qwen3-0.6B-4bit";
    const prompt = option(args, "--prompt") ?? "The capital of France is";
    const maxTokens = Number(option(args, "--max-tokens") ?? "16");
    const startedAt = performance.now();
    const { model, tokenizer } = await mlx.load(repo);
    let text = "";
    for await (const chunk of mlx.streamText(model, tokenizer, tokenizer.encode(prompt), {
      max: maxTokens,
      temp: 0,
    })) {
      text += chunk;
    }
    emit({
      ok: text.length > 0,
      ...base,
      model: repo,
      prompt,
      text,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    if (text.length === 0) process.exitCode = 1;
  } else if (command === "transcribe") {
    const audio = requiredOption(args, "--audio");
    const assets = requiredOption(args, "--assets");
    const maxTokens = Number(option(args, "--max-tokens") ?? "224");
    await Promise.all([
      requireFile(audio),
      requireFile(`${assets}/config.json`),
      requireFile(`${assets}/weights.safetensors`),
      requireFile(`${assets}/whisper-multilingual.tiktoken`),
      requireFile(`${assets}/whisper-mel-filters-128.f32`),
    ]);

    const [model, tokenizer, filters, pcm] = await Promise.all([
      mlx.loadWhisper(`${assets}/config.json`, `${assets}/weights.safetensors`),
      mlx.WhisperTokenizer.fromFile(`${assets}/whisper-multilingual.tiktoken`),
      mlx.loadMelFilters(`${assets}/whisper-mel-filters-128.f32`, 128),
      mlx.decodeAudio(audio),
    ]);
    const startedAt = performance.now();
    const ids = model.transcribe(pcm, filters, { max: maxTokens });
    emit({
      ok: true,
      ...base,
      text: tokenizer.decode(ids).trim(),
      tokens: ids.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  } else {
    throw new Error(`unknown worker command: ${command}`);
  }
} catch (error) {
  emit({
    ok: false,
    kind: "runtime-error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

function option(values, name) {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function requiredOption(values, name) {
  const value = option(values, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function requireFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`required file not found: ${path}`);
  }
}

function emit(value) {
  console.log(JSON.stringify(value));
}
