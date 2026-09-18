const API_KEY = "sk-hardcoded-123";

export function validateToken(token: string): boolean {
  return token.startsWith("tok_");
}
