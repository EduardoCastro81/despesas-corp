'use strict';
// Limitador simples em memória (suficiente para um único servidor).
// Bloqueia após `max` falhas dentro de `windowMs`, pelo tempo de `blockMs`.

function createLimiter({ max, windowMs, blockMs }) {
  const hits = new Map(); // chave -> { count, first, blockedUntil }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.blockedUntil < now && now - v.first > windowMs) hits.delete(k);
  }, 60000);
  sweep.unref?.();

  return {
    // Retorna segundos restantes de bloqueio (0 = liberado)
    blockedFor(key) {
      const v = hits.get(key);
      if (!v) return 0;
      const left = v.blockedUntil - Date.now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
    fail(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || now - v.first > windowMs) v = { count: 0, first: now, blockedUntil: 0 };
      v.count += 1;
      if (v.count >= max) { v.blockedUntil = now + blockMs; v.count = 0; v.first = now; }
      hits.set(key, v);
    },
    reset(key) { hits.delete(key); },
    clear() { hits.clear(); },
  };
}

const MIN = 60 * 1000;
// Login: 5 erros por e-mail (ou 20 por IP) em 15 min bloqueiam por 15 min
const loginByEmail = createLimiter({ max: 5, windowMs: 15 * MIN, blockMs: 15 * MIN });
const loginByIp = createLimiter({ max: 20, windowMs: 15 * MIN, blockMs: 15 * MIN });
// Recuperação de senha: 5 pedidos por IP por hora
const forgotByIp = createLimiter({ max: 5, windowMs: 60 * MIN, blockMs: 60 * MIN });

module.exports = { createLimiter, loginByEmail, loginByIp, forgotByIp };
