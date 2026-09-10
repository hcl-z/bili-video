# mlx-ts 隔离 POC

独立验证 `@nielspeter/mlx-ts@0.4.1`，不接入 `src/server`，也不替换现有 `mlx_audio + Qwen3-ASR` 链路。native FFI 始终运行在子进程；段错误只会变成 `native-crash` 诊断。

```bash
cd poc/mlx-ts
pnpm install
pnpm probe
```

当前版本只提供 Whisper ASR，不支持 Qwen3-ASR。若基础探针通过，可自行准备 mlx-ts README 指定的 Whisper 资产后运行：

```bash
pnpm transcribe -- --audio /path/to/audio.m4a --assets /path/to/assets
```

资产目录需包含 `config.json`、`weights.safetensors`、`whisper-multilingual.tiktoken` 和 `whisper-mel-filters-128.f32`。

已知限制：Node 24 + Koffi 后端在导入阶段可能因错误回调指针解码而段错误；Bun 可完成导入，但预构建 MLX 库可能要求高于当前 macOS 所支持的 Metal language version。两者都由探针报告，不影响主服务。
