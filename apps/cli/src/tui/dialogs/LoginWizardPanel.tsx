import type { IPlatformService } from "@kcode/contracts";
import { useServices, type ServiceSet } from "@kcode/ui";
import { Box, Text } from "ink";
import { saveUserModelsConfig } from "../../bootstrap.js";
import { c } from "../theme/theme.js";
import type { PushBlock } from "./panels.js";
import { OptionsMenu } from "./OptionsMenu.js";
import { HiddenInput } from "./HiddenInput.js";
import { PromptInput } from "./PromptInput.js";
import { LOGIN_PRESETS, type LoginWizard } from "./wizard-state.js";

/** CLI 侧注入的服务集形状（ServicesProvider 由 App 装配，N2-3） */
export type CliServices = ServiceSet & { platform: IPlatformService };

/**
 * /login 向导（N2-3 外迁）：四段式录入厂商/模型/地址/key + 口令或 DPAPI。
 * 平台能力经 useServices 注入（IPlatformService，N2-1）——组件不 import 平台实现。
 */
export function LoginWizardPanel(props: {
  wizard: Exclude<LoginWizard, null>;
  setLoginWizard: (w: LoginWizard) => void;
  pushBlock: PushBlock;
}) {
  const { wizard } = props;
  const { platform } = useServices<CliServices>();
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
                props.setLoginWizard(null);
                return;
              }
              props.setLoginWizard({
                stage: "model",
                providerName: preset.name,
                presetBaseURL: preset.baseURL,
                presetModel: preset.model,
                baseURL: preset.baseURL,
                apiKey: "",
                model: preset.model,
              });
            }}
            onCancel={() => props.setLoginWizard(null)}
          />
        </>
      ) : wizard.stage === "model" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 2/4 模型名
          </Text>
          <PromptInput
            label="模型名: "
            initialValue={wizard.presetModel}
            onDone={(model) => props.setLoginWizard({ ...wizard, stage: "baseURL", model })}
            onCancel={() => props.setLoginWizard(null)}
          />
        </>
      ) : wizard.stage === "baseURL" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 3/4 API 地址
          </Text>
          <PromptInput
            label="BaseURL: "
            initialValue={wizard.presetBaseURL}
            onDone={(baseURL) =>
              props.setLoginWizard({ ...wizard, stage: "apikey", baseURL: baseURL.trim() })
            }
            onCancel={() => props.setLoginWizard(null)}
          />
        </>
      ) : wizard.stage === "apikey" ? (
        <>
          <Text color={c("accent")} bold>
            Login · 4/4 API key（输入不回显）
          </Text>
          <HiddenInput
            label="API key: "
            onDone={(apiKey) =>
              props.setLoginWizard({ ...wizard, stage: "passphrase", apiKey: apiKey.trim() })
            }
            onCancel={() => props.setLoginWizard(null)}
          />
        </>
      ) : (
        <>
          <Text color={c("accent")} bold>
            Login · 设置 keychain 口令（不回显；解锁本地 key 存储）
          </Text>
          {platform.secureStorageAvailable ? (
            <Text dimColor>Windows：口令留空回车 = 使用系统 DPAPI 免口令存储</Text>
          ) : null}
          <HiddenInput
            label="口令: "
            onDone={(pass) => {
              const w = wizard;
              props.setLoginWizard(null);
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
                  if (pass !== "") {
                    const kc = platform.openPassphraseKeychain(pass);
                    await kc.set(keyRef, w.apiKey, [w.baseURL]);
                    process.env["KCODE_KEYCHAIN_PASSPHRASE"] = pass;
                  } else {
                    // 口令留空：免口令系统存储（不支持的平台在此抛"口令不能为空"）
                    const kc = platform.openSecureKeychain();
                    await kc.set(keyRef, w.apiKey, [w.baseURL]);
                  }
                  props.pushBlock({
                    kind: "info",
                    tone: "ok",
                    text: `✓ 已保存 ${w.providerName} 配置与 key（默认模型 ${w.providerName}/${w.model}）——重启 kcode 后以新配置启动`,
                  });
                } catch (err) {
                  props.pushBlock({
                    kind: "info",
                    tone: "warn",
                    text: `✗ 保存失败：${err instanceof Error ? err.message : String(err)}（若提示解密失败，说明已有 keys.json 使用其他口令——删除 %USERPROFILE%\\.kcode\\keys.json 后重试 /login）`,
                  });
                }
              })();
            }}
            onCancel={() => props.setLoginWizard(null)}
          />
        </>
      )}
    </Box>
  );
}
