import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { findCustomerByEmail, createCustomer, createPixCharge } from '../_shared/asaas.ts';

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
    const { quantity } = await req.json();
    if (!quantity || quantity < 1 || quantity > 50) {
      return json({ error: 'Quantidade deve ser entre 1 e 50' }, 400);
    }

    // Autenticação obrigatória
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Não autenticado' }, 401);

    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) return json({ error: 'Não autenticado' }, 401);

    const db = getSupabaseClient();
    const { data: profile } = await db
      .from('users')
      .select('asaas_customer_id')
      .eq('id', user.id)
      .single();

    let customerId = profile?.asaas_customer_id;
    if (!customerId) {
      customerId = await findCustomerByEmail(user.email!);
      if (!customerId) {
        customerId = await createCustomer(user.email!, user.email!);
      }
      await db.from('users').update({ asaas_customer_id: customerId }).eq('id', user.id);
    }

    // Criar cobrança PIX avulsa
    const result = await createPixCharge(customerId, quantity);

    // Salvar pagamento
    await db.from('payments').insert({
      user_id: user.id,
      type: 'extra_searches',
      amount: quantity * 1.90,
      quantity,
      asaas_payment_id: result.paymentId,
      status: 'pending',
    });

    console.log(`[EncontraZap] Extra purchase: ${quantity} buscas para ${user.email}`);

    return json({
      paymentId: result.paymentId,
      qrCodeImage: result.encodedImage,
      qrCodeText: result.payload,
    });
  } catch (err) {
    console.error('[EncontraZap] Buy extra error:', err);
    return json({ error: err.message || 'Erro ao gerar cobrança' }, 500);
  }
});
