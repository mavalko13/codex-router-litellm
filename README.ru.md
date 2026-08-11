# Codex Router

[English](README.md) | [Русский](README.ru.md)

Codex Router позволяет использовать собственный LiteLLM gateway и другие
внешние модели в Codex App и CLI. Он работает локально, говорит с Codex через
Responses API, добавляет внешние модели в обычный picker и не заменяет нативные
GPT-модели.

Это независимый community project, не связанный с OpenAI, LiteLLM или
провайдерами моделей. Дистрибутив основан на open-source проекте
[Codex Router](https://github.com/duolahypercho/codex-router) с сохранением
upstream attribution и лицензии.

## Что получает пользователь

- Интерактивную установку на macOS, Windows и Linux.
- Видимый запрос URL собственного LiteLLM gateway.
- Скрытый ввод LiteLLM virtual key без передачи ключа в аргументах или chat.
- Получение доступных моделей из `/models` и явный локальный выбор моделей для
  picker.
- Защищённое пользовательское хранение URL, ключа и model curation.
- Локальную фоновую службу, doctor, rollback и redacted support bundle.
- Нативные GPT-модели продолжают работать через обычную авторизацию Codex.

Полная схема запросов, границы credentials, файлы состояния, обновление и
диагностика описаны в
[руководстве по LiteLLM gateway](docs/LITELLM-GATEWAY.ru.md).

## Интерактивная установка

Репозиторий публичный, поэтому эти команды загружают установщик напрямую с
GitHub без GitHub-аутентификации.

macOS или Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mavalko13/codex-router-litellm/main/install.sh \
  | sh -s -- --target codex --guided --providers litellm-gateway
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/mavalko13/codex-router-litellm/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -Providers litellm-gateway
```

Требования:

- установленный Codex App или Codex CLI;
- Node.js 22.19+; рекомендуется Node.js 24 LTS;
- `uv` либо Python 3.10+ с `venv`, если выбранному провайдеру нужен локальный
  LiteLLM bridge;
- Git для managed checkout, обновления и rollback.

В Windows guided setup проверяет Git и Node.js до изменения Codex. `uv`/Python
он запрашивает только после выбора провайдера, которому нужен локальный
LiteLLM bridge. Если чего-то не хватает, он предлагает установить точный пакет
через WinGet и продолжает в том же PowerShell после явного подтверждения. В
режиме `-Auto` системные зависимости никогда не устанавливаются автоматически.

Эти команды сразу выбирают только **Your LiteLLM Gateway**, поэтому общего
списка провайдеров нет. Установщик всё равно попросит пользователя ввести свой
OpenAI-compatible URL видимым текстом, а restricted virtual key — через
скрытый prompt. Адрес и ключ конкретного оператора не зашиты в публичный
установщик. Чтобы открыть полный список провайдеров в расширенном сценарии,
уберите `--providers litellm-gateway` в macOS/Linux или
`-Providers litellm-gateway` в Windows. Платный smoke test запускается только
при явном согласии.

Для **Your LiteLLM Gateway** прямой путь используют только модели, явно
объявленные как Responses-native. Curated Chat Completions модели идут через
локальный Python/LiteLLM adapter, чтобы корректно переводились инструменты и
история Codex. Установщик запускает или устанавливает adapter только когда он
нужен выбранным моделям.

После установки выберите модели:

```sh
./bin/model-router codex discover-models litellm-gateway
./bin/model-router codex curate-models litellm-gateway
./bin/model-router codex doctor
```

Windows:

```powershell
.\model-router.cmd codex discover-models litellm-gateway
.\model-router.cmd codex curate-models litellm-gateway
.\model-router.cmd codex doctor
```

Если при установке был выбран другой каталог, перейдите в этот managed checkout
вместо указанного выше стандартного пути.

После изменения picker полностью закройте Codex, снова откройте его и создайте
новую задачу.

## Автоматическое обновление моделей LiteLLM

Встроенный провайдер `litellm-gateway` явно включает автоматическое discovery,
поскольку URL и restricted virtual key задаёт сам оператор. Служба читает
`/v1/models` при установке/старте и затем раз в пять минут. Для фонового
запроса используется сохранённый ключ, а не временная переменная окружения.

Для каждой объявленной модели Router сохраняет достоверные
`max_input_tokens` и `max_output_tokens` из LiteLLM. Они применяются ко
встроенным, ручным и auto-curated моделям. Codex получает live
входной лимит как context window, а auto-compaction начинается на 85%.
Если LiteLLM не прислал валидный лимит, новые ID используют fallback
metadata: только text input, context window 131072, effort `high`, без
неподтверждённых vision, search, reasoning summary и `apply_patch`. По
умолчанию модель использует Chat Completions, а проверенный prefix
`codex-gpt-` выбирает Responses. Если другому alias нужен Responses, маршрут
можно задать или исправить без потери ручных metadata:

```sh
./bin/curate-models litellm-gateway --models MODEL_ID --api-surface responses --apply
```

Для обратного переключения используйте `--api-surface chat-completions`.
Существующие записи и ручные правки сохраняются. Для этого доверенного
opt-in gateway каждый успешно разобранный ответ `/v1/models` считается
authoritative только для auto-curated overlay: отсутствующие в нём ID из этого
overlay удаляются. Ручные записи и checked-in registry models сохраняются, а
ошибка или невалидный ответ discovery оставляет последние рабочие routes и
picker catalog.

После добавления модели перезапускается только локальный router stack: сначала
публикуются gateway routes, затем picker catalog. Durable pending marker
повторяет незавершённую публикацию при следующем старте. Codex Desktop читает
picker только при запуске, поэтому для появления новых моделей полностью
закройте и снова откройте Codex. Периодический опрос отключается значением
`MODEL_ROUTER_AUTO_CURATE_INTERVAL_MS=0`; другое значение должно быть целым
числом не меньше `60000` мс. Startup discovery и ручной `curate-models`
остаются доступны.

Пока supervised router работает, изменение сохранённого virtual key или
endpoint `litellm-gateway` запускает один немедленный discovery после debounce.
Watcher игнорирует остальные локальные state files, поэтому публикация catalog
не может запустить его повторно. Если filesystem watch недоступен, текущие
service и catalog сохраняются, а periodic check остаётся fallback.

При каждом обновлении каталога Router также проверяет
`agents.default_subagent_model` и явные `model` в role-файлах Codex.
Устаревший routed slug меняется только тогда, когда тот же провайдер публикует
ровно одного однозначного преемника. Глобальный default должен быть видимой v2
моделью; явный Router role-файл может перейти на точный v1 alias
`-no-fallback`. Если безопасной замены нет, Router не выбирает другую модель
наугад: `doctor` показывает точный файл и устаревшую ссылку, а остальные поля и
инструкции роли сохраняются. Symlink и другие non-regular файлы Router не
заменяет.

При одном `litellm-gateway` служба публикует `merged-models.json` без
локального LiteLLM bridge; при добавлении других routed providers сначала
публикуются LiteLLM routes, затем picker catalog.

## Обновление и rollback

Перед обновлением полностью закройте desktop-приложение Codex или ChatGPT.
Если используется только CLI, сначала завершите или остановите активные задачи.

macOS и Linux, стандартный managed checkout:

```sh
cd "${XDG_DATA_HOME:-$HOME/.local/share}/codex-router"
./bin/model-router codex update
./bin/model-router codex doctor
```

Windows PowerShell запускайте от имени того же пользователя, который запускает
ChatGPT/Codex, а не от администратора:

```powershell
Set-Location "$env:LOCALAPPDATA\codex-router"
.\model-router.cmd codex update
.\model-router.cmd codex doctor
```

Updater работает с managed Git checkout в ветке `main`, сохраняет предыдущую
ревизию для rollback и автоматически возвращает её, если новая установка не
проходит обязательные проверки. Несохранённые изменения tracked-файлов
блокируют обновление; untracked-файлы не удаляются и не мешают ему.

Если `doctor` показывает `FAIL`, выполните соответствующую repair-команду:

```sh
./bin/model-router codex doctor --fix
```

```powershell
.\model-router.cmd codex doctor --fix
```

После успешного обновления полностью откройте Codex/ChatGPT заново и создайте
новую задачу, чтобы приложение перечитало catalog моделей и определения
субагентов. Для возврата сохранённой ревизии используйте
`./bin/model-router codex rollback` на macOS/Linux или
`.\model-router.cmd codex rollback` на Windows. Установка из source archive без
`.git` не поддерживает updater: скачайте новый tagged release или повторно
запустите публичный guided installer.

## Безопасность

Не используйте LiteLLM master key. Создавайте отдельный virtual key для каждого
пользователя или компьютера и ограничивайте его моделями, бюджетом, RPM и
числом параллельных запросов.

URL хранится в `provider-endpoints.json`, virtual key — в отдельном
`litellm-gateway-api-key.secret`, выбранные модели — в `user-models.json`.
Файлы получают mode `600` на POSIX или ACL только для текущего пользователя на
Windows. Support bundle редактирует custom endpoint и credentials.

## Ветки и публикация

`main` предназначен для всех и не содержит персональный URL, ключи или
внутренние model definitions. Личная beta должна находиться в отдельном
приватном репозитории: при переводе GitHub-репозитория в public публичными
становятся все его ветки.

## Диагностика

```sh
./bin/model-router codex provider-endpoint litellm-gateway status
./bin/model-router codex provider-key litellm-gateway status
./bin/model-router codex doctor
./bin/support-bundle
```

`doctor` показывает точный неисправный слой и безопасное действие для ремонта.
Support bundle остаётся локальным и не загружается автоматически.

## Локальная проверка

Перед pull request можно запустить основной набор проверок локально:

```sh
npm run verify:local
```

Команда выполняет чистую установку dependencies, syntax checks, полный Node
test suite, production dependency audit и проверки entrypoints текущей ОС.
После изменения Desktop используйте `npm run verify:local:full`: дополнительно
проверяется Rust/Tauri app и собирается native binary; нужны `cargo` и `rustc`.
`npm run verify:local:fast` подходит для повторного запуска с уже актуальными
dependencies, а `npm run verify:local:plan` только печатает полный план.
Provider API и платные модели эти команды не вызывают.

В публичном репозитории hosted CI по-прежнему автоматически запускается для
push и pull request, Python-lock проверяется по расписанию, а CodeQL остаётся
включённым. Локальная проверка дополняет эти gates, а не заменяет их.
