/**
 * services/server（Fastify 单体，§4.1 四模块硬隔离）。P4 落地：
 * relay（WSS 密文透传 + 设备授权表 + 会话锁租约）/ auth（IdP 反代 + 设备公钥注册）
 * / registry（Sigstore 验证 + 副签 + 扫描门 + CRL）/ usage（BullMQ 计量）。
 * 部署：deploy/docker-compose.yml（server + zitadel + postgres + redis）。
 */
console.log("kcode server — N4 落地（见 DESIGN.md §8.5）");
