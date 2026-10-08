import { useServices } from "@kcode/ui";
import { Box, Text } from "ink";
import { saveUserModelsConfig } from "../../bootstrap.js";
import { c } from "../theme/theme.js";
import { OptionsMenu } from "./OptionsMenu.js";
import { HiddenInput } from "./HiddenInput.js";
import { PromptInput } from "./PromptInput.js";
import { LOGIN_PRESETS, type LoginWizard } from "./wizard-state.js";
import type { CliServices } from "../state/services.js";

/**
 * /login 向导（N2-3 外迁）：四段式录入厂商/模型/地址/key + 口令或 DPAPI。
 * 平台能力与面板动作经 useServices 注入（N2-1 IPlatformService + N2-3 注入补全）。
 */
/** 向导统一底部提示（对齐批：可发现性——取消/回退机制曾不可见） */
function WizardHints(props: { first?: boolean }) {
  return (
    <Text dimColor>
      {props.first === true ? "回车 下一步 · Esc 取消" : "回车 下一步 · 空输入退格 上一步 · Esc 取消"}
    </Text>
  );
}

export function LoginWizardPanel(props: { wizard: Exclude<LoginWizard, null> }) {
  const { wizard } = props;
  const { platform, dialogs } = useServices<CliServices>();
  return (
    <Box flexDirection="column">
      {wizard.stage === "method" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 选择模型厂商（Esc 取消）
          </Text>
          <OptionsMenu
            options={LOGIN_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
            onPick={(indices) => {
              const preset = LOGIN_PRESETS[indices[0] ?? 0];
              if (preset === undefined) {
                dialogs.setLoginWizard(null);
                return;
              }
              dialogs.setLoginWizard({
                stage: "model",
                providerName: preset.name,
                presetBaseURL: preset.baseURL,
                presetModel: preset.model,
                baseURL: preset.baseURL,
                apiKey: "",
                model: preset.model,
              });
            }}
              onCancel={() => dialogs.setLoginWizard(null)}
          />
          <WizardHints first />
        </>
      ) : wizard.stage === "model" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 2/4 模型名（Esc 取消）
          </Text>
          <PromptInput
            label="模型名: "
            initialValue={wizard.presetModel}
            onDone={(model) => dialogs.setLoginWizard({ ...wizard, stage: "baseURL", model })}
            onCancel={() => dialogs.setLoginWizard(null)}
            onBack={() => dialogs.setLoginWizard({ ...wizard, stage: "method" })}
          />
          <WizardHints />
        </>
      ) : wizard.stage === "baseURL" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 3/4 API 地址（回车接受预填 · Esc 取消）
          </Text>
          <PromptInput
            label="BaseURL: "
            initialValue={wizard.presetBaseURL}
            onDone={(baseURL) =>
              dialogs.setLoginWizard({ ...wizard, stage: "apikey", baseURL: baseURL.trim() })
            }
            onCancel={() => dialogs.setLoginWizard(null)}
            onBack={() => dialogs.setLoginWizard({ ...wizard, stage: "model" })}
          />
          <WizardHints />
        </>
      ) : wizard.stage === "apikey" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 4/4 API key（输入不回显 · Esc 取消）
          </Text>
          <HiddenInput
            label="API key: "
            onDone={(apiKey) =>
              dialogs.setLoginWizard({ ...wizard, stage: "passphrase", apiKey: apiKey.trim() })
            }
            onCancel={() => dialogs.setLoginWizard(null)}
            onBack={() => dialogs.setLoginWizard({ ...wizard, stage: "baseURL" })}
          />
          <WizardHints />
        </>
      ) : (
        <>
          <Text color={c("accent")} bold>
            Login · 设置 keychain 口令（不回显；解锁本地 key 存储 · Esc 取消）
          </Text>
          {platform.secureStorageAvailable ? (
            <Text dimColor>Windows：口令留空回车 = 使用系统 DPAPI 免口令存储</Text>
          ) : null}
          <HiddenInput
            label="口令: "
            onBack={() => dialogs.setLoginWizard({ ...wizard, stage: "apikey" })}
            onDone={(pass) => {
              const w = wizard;
              dialogs.setLoginWizard(null);
              void (async () => {
                try {
                  const keyRef = `keychain://${w.providerName}`;
                  await saveUserModelsConfig({
                    default: `${w.providerName}/${w.model}`,
                    providers: {
                      [w.providerName]: {
                        type: "openai-compatible",
                        baseURL: w.baseURL,
                        keyRef,
                      },
                    },
                  });
                  // N3-2 注 E：key 录入走 PlatformClientPort.saveKey（宿主侧选择存储方式，
                  // 前端不感知 openPassphraseKeychain/openSecureKeychain——key 明文不出宿主）
                  await platform.saveKey(keyRef, w.apiKey, [w.baseURL], pass !== "" ? pass : undefined);
                  if (pass !== "") {
                    process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
                  }
                  dialogs.pushBlock({
                    kind: "info",
                    tone: "ok",
                    text: `✓ 已保存 ${w.providerName} 配置与 key（默认模型 ${w.providerName}/${w.model}）——重启 kcode 后以新配置启动`,
                  });
                } catch (err) {
                  dialogs.pushBlock({
                    kind: "info",
                    tone: "warn",
                    text: `✗ 保存失败：${err instanceof Error ? err.message : String(err)}（若提示解密失败，说明已有 keys.json 使用其他口令——删除 %USERPROFILE%\\.kcode\\keys.json 后重试 /login）`,
                  });
                }
              })();
            }}
            onCancel={() => dialogs.setLoginWizard(null)}
          />
          <WizardHints />
        </>
      )}
    </Box>
  );
}
