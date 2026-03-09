import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const event = body.event;
    const paymentId = body.payment?.id;

    console.log(`[EncontraZap Webhook] Event: ${event}, PaymentId: ${paymentId}`);

    const db = getSupabaseClient();

    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
      if (!paymentId) return json({ ok: true });

      // Buscar pagamento no nosso banco
      const { data: payment } = await db
        .from('payments')
        .select('*')
        .eq('asaas_payment_id', paymentId)
        .single();

      if (!payment) {
        console.log(`[EncontraZap Webhook] Payment ${paymentId} não encontrado no banco`);
        return json({ ok: true });
      }

      // Atualizar status do pagamento
      await db
        .from('payments')
        .update({ status: 'paid' })
        .eq('id', payment.id);

      if (payment.type === 'subscription') {
        // Ativar plano pago
        await db
          .from('users')
          .update({ plan: 'paid', searches_left: 20 })
          .eq('id', payment.user_id);
        console.log(`[EncontraZap Webhook] User ${payment.user_id} → plan=paid, searches=20`);
      } else if (payment.type === 'extra_searches') {
        // Adicionar buscas extras
        const { data: user } = await db
          .from('users')
          .select('searches_left')
          .eq('id', payment.user_id)
          .single();
        if (user) {
          await db
            .from('users')
            .update({ searches_left: user.searches_left + (payment.quantity || 0) })
            .eq('id', payment.user_id);
          console.log(`[EncontraZap Webhook] User ${payment.user_id} +${payment.quantity} buscas`);
        }
      }
    }

    if (event === 'PAYMENT_OVERDUE') {
      console.log(`[EncontraZap Webhook] Payment overdue: ${paymentId}`);
      if (paymentId) {
        await db
          .from('payments')
          .update({ status: 'failed' })
          .eq('asaas_payment_id', paymentId);
      }
    }

    // Subscription cancelada
    if (event === 'SUBSCRIPTION_DELETED' || event === 'SUBSCRIPTION_INACTIVATED') {
      const subscriptionId = body.subscription?.id || body.id;
      console.log(`[EncontraZap Webhook] Subscription deleted: ${subscriptionId}`);

      // Buscar pagamento da subscription pra pegar user_id
      const { data: subPayment } = await db
        .from('payments')
        .select('user_id')
        .eq('type', 'subscription')
        .eq('asaas_payment_id', subscriptionId)
        .single();

      if (subPayment) {
        await db
          .from('users')
          .update({ plan: 'free', searches_left: 0 })
          .eq('id', subPayment.user_id);
        console.log(`[EncontraZap Webhook] User ${subPayment.user_id} → plan=free`);
      }
    }

    return json({ ok: true });
  } catch (err) {
    console.error('[EncontraZap Webhook] Error:', err);
    return json({ ok: true }); // Sempre retorna 200 pra webhook não reenviar
  }
});
