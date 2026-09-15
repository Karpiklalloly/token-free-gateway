# Models Refresh — Design (2026-09-15)

## Context
- Модели захардкожены в `src/providers/*/index.ts` (`definition.models`).
- `registry.listAllModels()` фильтрует по залогиненным (`auth-profiles.json`), `GET /v1/models` отдает статику за мс.
- Живого фетча нет ни у одного провайдера. CLI: `serve/start/stop/restart/status/webauth/chrome` (`index.ts`).
- Решение: вариант А — кэш + refresh на старте и по запросу (выбран пользователем). Вариант Б (всегда live на каждый GET) отклонен: 13 браузерных сессий на запрос = секунды-десятки, flaky, ломает OpenAI-клиенты.

## Architecture
- Новый `src/providers/model-cache.ts`: JSON `~/.token-free-gateway/models-cache.json`
  `{ [providerId]: { models: ModelInfo[], updatedAt: string } }`, `TFG_STORE_PATH`-aware для тестов.
- `registry.listAllModels()`: сначала кэш — если есть запись для провайдера, отдать ее, иначе статику из `definition.models`. Только для залогиненных провайдеров (как сейчас).
- Новая `registry.refreshModels(providerId?)`: для каждого залогиненного (или одного) провайдера получить клиент, вызвать `fetchModels()` с таймаутом ~15с, записать кэш. Ошибка одного ≠ провал всех.

## Components
1. `WebProviderClient.fetchModels?(): Promise<ModelInfo[]>` — опциональный хук.
   `BaseApiClient` / `BaseDomClient` дефолт: `return this.config.models` (статика).
   Живые override'ы per-provider — follow-up задачи, не этот спек.
2. `server.ts`: на старте фоном best-effort `refreshModels()` (не блокирует `Bun.serve`);
   `GET /v1/models`, `GET /v1/models/:id` — без смены сигнатуры, кэш-aware;
   новый `POST /v1/models/refresh` → `{ refreshed: string[], failed: { provider, reason }[], models: number }`.
3. CLI `src/cli/models.ts` + ветка в `index.ts`: `models [provider] [--refresh] [--json]`.
   Если демон бежит (`gateway.pid` + порт отвечает) — бьет в HTTP (`POST` при `--refresh`, иначе `GET`);
   иначе напрямую в `registry` (standalone). Плюс строка в `--help`.

## Data flow
- Старт: `serve/__serve` → `refreshModels()` в фоне → `GET /v1/models` сразу отдает кэш/статику.
- Ручной: `models --refresh` / `POST /v1/models/refresh` → параллельный проход по провайдерам → обновление кэш-файла → отчет.
- Просмотр: `models` / `GET /v1/models` → чтение кэша, без браузера.

## Error handling
- Провал провайдера: запись в `failed`, кэш не трогаем, отдаем статику. Сервер/CLI не падают.
- Просрочка сессии: `failed` с `reason` + подсказка `webauth`.
- CLI exit-код: `0` если хоть один обновлен или просто листинг, `1` если все провалились / демон недоступен и standalone не удался.
- Таймауты: per-provider ~15с, общий refresh не вешает сервер (фоновый на старте, синхронный с таймаутом на POST).

## Testing
- `bun test`: roundtrip `model-cache` (save/load, missing file → `{}`); `refreshModels` с мок-клиентом (успех пишет кэш, ошибка → fallback к статике, таймаут → `failed`); `listAllModels` предпочитает кэш.
- Ручная проверка: `models --refresh`, `curl GET /v1/models`, `curl -X POST /v1/models/refresh`.

## Out of scope
- Реальные `fetchModels()` override'ы для 13 провайдеров (отдельные задачи).
- TTL/инвалидация кэша по времени (пока только явный refresh + старт).
- Миграции старого кэша.
