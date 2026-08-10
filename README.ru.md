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

Пока репозиторий приватный, команды загрузки по public raw URL работать не
будут без GitHub-аутентификации. После отдельного решения о публикации команды
будут такими.

macOS или Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mavalko13/codex-router-litellm/main/install.sh \
  | sh -s -- --target codex --guided
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/mavalko13/codex-router-litellm/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided
```

Требования:

- установленный Codex App или Codex CLI;
- Node.js 22.19+; рекомендуется Node.js 24 LTS;
- `uv` либо Python 3.10+ с `venv`;
- Git для managed checkout, обновления и rollback.

В guided setup выберите **Your LiteLLM Gateway**. Установщик сначала спросит
OpenAI-compatible URL, затем virtual key через скрытый prompt. Платный smoke
test запускается только при явном согласии.

После установки выберите модели:

```sh
./bin/model-router codex discover-models litellm-gateway
./bin/model-router codex curate-models litellm-gateway
./bin/model-router codex doctor
```

Windows:

```powershell
./model-router.ps1 codex discover-models litellm-gateway
./model-router.ps1 codex curate-models litellm-gateway
./model-router.ps1 codex doctor
```

После изменения picker полностью закройте Codex, снова откройте его и создайте
новую задачу.

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

Текущий репозиторий остаётся приватным до отдельного запроса на публикацию.
Перед публикацией выполняются финальная проверка истории, секретов, CI и
public install URLs. После этого реальная установка на Windows коллегой служит
отдельным acceptance test.

## Диагностика

```sh
./bin/model-router codex provider-endpoint litellm-gateway status
./bin/model-router codex provider-key litellm-gateway status
./bin/model-router codex doctor
./bin/support-bundle
```

`doctor` показывает точный неисправный слой и безопасное действие для ремонта.
Support bundle остаётся локальным и не загружается автоматически.
