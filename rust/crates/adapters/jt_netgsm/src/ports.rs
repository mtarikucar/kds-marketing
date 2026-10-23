//! The connector ports of `jt_app`, implemented by [`NetgsmConnector`] over the modules beside
//! this one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    Connector, ConsentRow, ConsentSync, DeliveryReports, DeliveryStatus, InboundEventDraft,
    SendReceipt, SmsSender, Telephony,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::OffsetDateTime;

use crate::{NETGSM_HOSTS, NetgsmConnector, iys, probe, santral, sms};

#[async_trait]
impl Connector for NetgsmConnector {
    fn provider(&self) -> Provider {
        Provider::Netgsm
    }

    fn hosts(&self) -> &'static [&'static str] {
        NETGSM_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        probe::probe(self, cred, public).await
    }

    /// NetGSM credentials are entered by hand and never expire on their own: nothing to renew.
    async fn refresh(&self, _cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        Ok(None)
    }
}

#[async_trait]
impl SmsSender for NetgsmConnector {
    async fn send(
        &self,
        cred: &Credential,
        to: &str,
        text: &str,
        reference: Option<&str>,
    ) -> Result<SendReceipt, ConnectorError> {
        sms::send(self, cred, to, text, reference).await
    }
}

#[async_trait]
impl DeliveryReports for NetgsmConnector {
    async fn report(
        &self,
        cred: &Credential,
        job_ids: &[String],
    ) -> Result<Vec<DeliveryStatus>, ConnectorError> {
        sms::report(self, cred, job_ids).await
    }

    async fn inbox(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        sms::inbox(self, cred, from, to).await
    }
}

#[async_trait]
impl Telephony for NetgsmConnector {
    async fn click_to_call(
        &self,
        cred: &Credential,
        public: &Value,
        from_ext: &str,
        to: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        santral::click_to_call(self, cred, public, from_ext, to).await
    }

    async fn hangup(&self, cred: &Credential, call_id: &str) -> Result<(), ConnectorError> {
        santral::hangup(self, cred, call_id).await
    }
}

#[async_trait]
impl ConsentSync for NetgsmConnector {
    async fn add(
        &self,
        cred: &Credential,
        rows: &[ConsentRow],
    ) -> Result<SendReceipt, ConnectorError> {
        iys::add(self, cred, rows).await
    }
}
