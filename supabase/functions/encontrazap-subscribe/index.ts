import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { findCustomerByEmail, createCustomer, createSubscription } from '../_shared/asaas.ts';

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

    // Pegar CPF do body (opcional)
    const body = await req.json().catch(() => ({}));
    const cpf = body.cpf || '';

    const db = getSupabaseClient();
    const { data: profile } = await db
      .from('users')
      .select('asaas_customer_id')
      .eq('id', user.id)
      .single();

    // Buscar ou criar customer no Asaas
    let customerId = profile?.asaas_customer_id;
    if (!customerId) {
      customerId = await findCustomerByEmail(user.email!);
      if (!customerId) {
        customerId = await createCustomer(user.email!, user.email!, cpf);
      }
      // Salvar customer_id no perfil
      await db
        .from('users')
        .update({ asaas_customer_id: customerId })
        .eq('id', user.id);
    }

    // Criar autorização PIX Automático
    const result = await createSubscription(customerId);

    // Salvar pagamento com authorizationId
    await db.from('payments').insert({
      user_id: user.id,
      type: 'subscription',
      amount: 97.00,
      asaas_payment_id: result.authorizationId,
      status: 'pending',
    });

    console.log(`[EncontraZap] PIX Automático criado para ${user.email} — auth: ${result.authorizationId}`);

    return json({
      authorizationId: result.authorizationId,
      qrCodeImage: result.encodedImage,
      qrCodeText: result.payload,
    });
  } catch (err) {
    console.error('[EncontraZap] Subscribe error:', err);
    return json({ error: err.message || 'Erro ao criar assinatura' }, 500);
  }
});
