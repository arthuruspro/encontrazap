import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getPaymentStatus, getPixAutomaticStatus } from '../_shared/asaas.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const body = await req.json();

    // Suporta verificação de PIX Automático (authorizationId) ou cobrança avulsa (paymentId)
    if (body.authorizationId) {
      const result = await getPixAutomaticStatus(body.authorizationId);
      return json({
        paid: result.active,
        status: result.status,
      });
    }

    if (body.paymentId) {
      const result = await getPaymentStatus(body.paymentId);
      return json({
        paid: result.paid,
        status: result.status,
      });
    }

    return json({ error: 'paymentId ou authorizationId obrigatório' }, 400);
  } catch (err) {
    console.error('[EncontraZap] Verify payment error:', err);
    return json({ error: err.message || 'Erro ao verificar pagamento' }, 500);
  }
});
