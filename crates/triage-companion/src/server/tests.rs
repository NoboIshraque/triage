//! The server against a phone written in Rust: WebTransport with the
//! certificate pinned by its hash (as a browser does it), and a relay in the test.

use super::*;
use crate::cert;
use crate::noise::{Channel, Initiator, Keypair, generate_keypair};
use crate::wire::{PROTOCOL_VERSION, parse};
use wtransport::ClientConfig;
use wtransport::tls::Sha256Digest;

struct Laptop {
    companion: Companion,
    keys: Keypair,
    certificate: Certificate,
    port: u16,
}

fn laptop() -> Laptop {
    let keys = generate_keypair();
    let now = now_ms() / 1000;
    let certificate = cert::plan(Vec::new(), now).expect("certificates").remove(0);
    let companion = Companion::new(keys.private);
    let port = companion.listen(0, &certificate).expect("listen");
    Laptop {
        companion,
        keys,
        certificate,
        port,
    }
}

/// IPv4 only: some test machines (cloud containers) have no IPv6.
fn client_config()
-> wtransport::config::ClientConfigBuilder<wtransport::config::states::WantsRootStore> {
    ClientConfig::builder()
        .with_bind_address(SocketAddr::new(std::net::Ipv4Addr::UNSPECIFIED.into(), 0))
}

struct Phone {
    send: wtransport::SendStream,
    recv: wtransport::RecvStream,
    decoder: Decoder,
    pending: std::collections::VecDeque<Frame>,
    _connection: wtransport::Connection,
}

impl Phone {
    async fn connect(laptop: &Laptop) -> Result<Self, String> {
        let config = client_config()
            .with_server_certificate_hashes([Sha256Digest::new(laptop.certificate.hash())])
            .build();
        let endpoint = Endpoint::client(config).map_err(|e| e.to_string())?;
        let connection = endpoint
            .connect(format!("https://127.0.0.1:{}{PATH}", laptop.port))
            .await
            .map_err(|e| e.to_string())?;
        let (send, recv) = connection
            .open_bi()
            .await
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            send,
            recv,
            decoder: Decoder::default(),
            pending: std::collections::VecDeque::new(),
            _connection: connection,
        })
    }

    async fn write(&mut self, kind: Kind, payload: &[u8]) {
        self.send
            .write_all(&wire::encode(kind, payload))
            .await
            .expect("write");
    }

    async fn read(&mut self) -> Option<Frame> {
        let mut buffer = vec![0u8; 70_000];
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return Some(frame);
            }
            match tokio::time::timeout(Duration::from_secs(10), self.recv.read(&mut buffer)).await {
                Ok(Ok(Some(n))) => self
                    .pending
                    .extend(self.decoder.push(&buffer[..n]).expect("frames")),
                _ => return None,
            }
        }
    }

    /// Runs a handshake; returns the channel, or the laptop's refusal.
    async fn handshake(
        &mut self,
        mode: Mode,
        id: [u8; 16],
        keys: &Keypair,
        laptop_key: &[u8; 32],
        psk: Option<[u8; 32]>,
    ) -> Result<Channel, Refusal> {
        let header = InitHeader {
            version: PROTOCOL_VERSION,
            mode,
            id,
        };
        let mut initiator =
            Initiator::new(&header, Some(&keys.private), Some(laptop_key), psk.as_ref())
                .expect("initiator");
        let mut init = header.to_bytes().to_vec();
        init.extend(initiator.write_init(b"").expect("init"));
        self.write(Kind::Init, &init).await;
        let frame = self.read().await.ok_or(Refusal::Closed)?;
        match frame.kind {
            Kind::Reply => {
                let (_, mut channel) = initiator
                    .read_reply(&frame.payload, 1 << 24)
                    .map_err(|_| Refusal::HandshakeFailed)?;
                for sealed in channel.seal(b"{\"hello\":1}").expect("seal") {
                    self.write(Kind::Sealed, &sealed).await;
                }
                Ok(channel)
            }
            Kind::Refused => Err(Refusal::from_byte(frame.payload[0]).expect("refusal")),
            _ => panic!("unexpected {:?}", frame.kind),
        }
    }

    async fn refusal(&mut self) -> Option<Refusal> {
        loop {
            let frame = self.read().await?;
            if frame.kind == Kind::Refused {
                return Refusal::from_byte(frame.payload[0]);
            }
        }
    }
}

async fn next_handshake(companion: &Companion) -> (u32, String, Vec<u8>, [u8; 32]) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), companion.next_event())
            .await
            .expect("an event in time")
            .expect("event");
        if let Event::Handshake {
            session,
            sas,
            hello,
            phone_key,
            ..
        } = event
        {
            return (session, sas, hello, phone_key);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_pairs_on_the_lan_and_messages_flow_both_ways() {
    let laptop = laptop();
    let id = crate::qr::random::<16>();
    let secret = crate::qr::random::<32>();
    laptop
        .companion
        .add_pairing(id, Mode::Pair, secret, now_ms() + 90_000);
    let phone_keys = generate_keypair();
    let mut phone = Phone::connect(&laptop).await.expect("connect");
    let mut channel = phone
        .handshake(
            Mode::Pair,
            id,
            &phone_keys,
            &laptop.keys.public,
            Some(secret),
        )
        .await
        .expect("handshake");
    let (session, sas, hello, phone_key) = next_handshake(&laptop.companion).await;
    assert_eq!(sas, channel.sas(), "both screens show the same six digits");
    assert_eq!(hello, b"{\"hello\":1}");
    assert_eq!(phone_key, phone_keys.public);
    // A large message (a display list) arrives in fragments.
    let big = vec![9u8; 300_000];
    assert!(laptop.companion.send(session, big.clone()));
    let mut received = None;
    while received.is_none() {
        let frame = phone.read().await.expect("frame");
        assert_eq!(frame.kind, Kind::Sealed);
        received = channel.open(&frame.payload).expect("open");
    }
    assert_eq!(received, Some(big));
    // The phone's message reaches the window.
    for sealed in channel.seal(b"tap").expect("seal") {
        phone.write(Kind::Sealed, &sealed).await;
    }
    match laptop.companion.next_event().await.expect("event") {
        Event::Message { session: s, data } => {
            assert_eq!((s, data.as_slice()), (session, &b"tap"[..]));
        }
        other => panic!("unexpected {other:?}"),
    }
    laptop.companion.close(session, Refusal::Closed, "removed");
    assert_eq!(phone.refusal().await, Some(Refusal::Closed));
}

#[tokio::test(flavor = "multi_thread")]
async fn reused_expired_and_wrong_qr_codes_are_refused() {
    let laptop = laptop();
    let id = crate::qr::random::<16>();
    let secret = crate::qr::random::<32>();
    laptop
        .companion
        .add_pairing(id, Mode::Pair, secret, now_ms() + 90_000);
    let keys = generate_keypair();
    let mut phone = Phone::connect(&laptop).await.expect("connect");
    phone
        .handshake(Mode::Pair, id, &keys, &laptop.keys.public, Some(secret))
        .await
        .expect("handshake");
    let _ = next_handshake(&laptop.companion).await;
    laptop.companion.consume_pairing(&id);
    // Reused.
    let mut again = Phone::connect(&laptop).await.expect("connect");
    assert_eq!(
        again
            .handshake(
                Mode::Pair,
                id,
                &generate_keypair(),
                &laptop.keys.public,
                Some(secret)
            )
            .await
            .err(),
        Some(Refusal::Expired)
    );
    // Expired.
    let old = crate::qr::random::<16>();
    laptop
        .companion
        .add_pairing(old, Mode::Pair, secret, now_ms() - 1);
    let mut late = Phone::connect(&laptop).await.expect("connect");
    assert_eq!(
        late.handshake(Mode::Pair, old, &keys, &laptop.keys.public, Some(secret))
            .await
            .err(),
        Some(Refusal::Expired)
    );
    // A wrong secret fails on the phone (psk2), and the laptop counts it once
    // the phone's sealed message fails; five failures end the code.
    let fresh = crate::qr::random::<16>();
    laptop
        .companion
        .add_pairing(fresh, Mode::Pair, secret, now_ms() + 90_000);
    for _ in 0..MAX_ATTEMPTS {
        let mut wrong = Phone::connect(&laptop).await.expect("connect");
        let header = InitHeader {
            version: PROTOCOL_VERSION,
            mode: Mode::Pair,
            id: fresh,
        };
        let mut initiator = Initiator::new(
            &header,
            Some(&keys.private),
            Some(&laptop.keys.public),
            Some(&[1; 32]),
        )
        .expect("initiator");
        let mut init = header.to_bytes().to_vec();
        init.extend(initiator.write_init(b"").expect("init"));
        wrong.write(Kind::Init, &init).await;
        assert_eq!(wrong.read().await.expect("reply").kind, Kind::Reply);
        // An attacker without the secret can only send bytes that don't open.
        wrong.write(Kind::Sealed, &[0u8; 40]).await;
        assert!(matches!(
            wrong.refusal().await,
            Some(Refusal::HandshakeFailed | Refusal::TooManyAttempts)
        ));
    }
    let mut last = Phone::connect(&laptop).await.expect("connect");
    assert_eq!(
        last.handshake(Mode::Pair, fresh, &keys, &laptop.keys.public, Some(secret))
            .await
            .err(),
        Some(Refusal::TooManyAttempts)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn paired_phones_reconnect_and_removed_ones_are_refused() {
    let laptop = laptop();
    let keys = generate_keypair();
    let mailbox = crate::qr::random::<16>();
    laptop.companion.set_phones(vec![(mailbox, keys.public)]);
    let mut phone = Phone::connect(&laptop).await.expect("connect");
    phone
        .handshake(Mode::Reconnect, mailbox, &keys, &laptop.keys.public, None)
        .await
        .expect("reconnect");
    let (_, _, _, key) = next_handshake(&laptop.companion).await;
    assert_eq!(key, keys.public);
    // Another phone claiming that mailbox.
    let mut impostor = Phone::connect(&laptop).await.expect("connect");
    assert_eq!(
        impostor
            .handshake(
                Mode::Reconnect,
                mailbox,
                &generate_keypair(),
                &laptop.keys.public,
                None
            )
            .await
            .err(),
        Some(Refusal::NotPaired)
    );
    // Removed.
    laptop.companion.set_phones(Vec::new());
    let mut removed = Phone::connect(&laptop).await.expect("connect");
    assert_eq!(
        removed
            .handshake(Mode::Reconnect, mailbox, &keys, &laptop.keys.public, None)
            .await
            .err(),
        Some(Refusal::NotPaired)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_certificate_that_isnt_pinned_doesnt_connect() {
    let laptop = laptop();
    let other = cert::generate(now_ms() / 1000 - 3600).expect("certificate");
    let config = client_config()
        .with_server_certificate_hashes([Sha256Digest::new(other.hash())])
        .build();
    let endpoint = Endpoint::client(config).expect("client");
    assert!(
        endpoint
            .connect(format!("https://127.0.0.1:{}{PATH}", laptop.port))
            .await
            .is_err()
    );
    // After renewal the laptop serves the next certificate, which phones were given in advance.
    let next = cert::generate(now_ms() / 1000 - 3600).expect("certificate");
    laptop.companion.set_certificate(&next).expect("reload");
    let pinned = Laptop {
        certificate: next,
        ..laptop
    };
    assert!(Phone::connect(&pinned).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_from_other_origins_are_refused_when_origins_are_set() {
    let laptop = laptop();
    laptop
        .companion
        .set_allowed_origins(vec!["https://phone.example".into()]);
    // The Rust client sends no Origin header: refused.
    assert!(Phone::connect(&laptop).await.is_err());
}

/// A relay as small as the real one's core (companion/relay): pairs the
/// laptop and the phone of a mailbox and records what passes through.
async fn test_relay() -> (String, Arc<Mutex<Vec<Vec<u8>>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        let laptop = tokio_tungstenite::accept_async(listener.accept().await.expect("laptop").0)
            .await
            .expect("ws");
        let phone = tokio_tungstenite::accept_async(listener.accept().await.expect("phone").0)
            .await
            .expect("ws");
        let (mut laptop_sink, mut laptop_stream) = laptop.split();
        let (mut phone_sink, mut phone_stream) = phone.split();
        let up_log = Arc::clone(&log);
        let up = tokio::spawn(async move {
            while let Some(Ok(message)) = phone_stream.next().await {
                if let Message::Binary(bytes) = &message {
                    lock(&up_log).push(bytes.to_vec());
                }
                if laptop_sink.send(message).await.is_err() {
                    return;
                }
            }
        });
        while let Some(Ok(message)) = laptop_stream.next().await {
            if let Message::Binary(bytes) = &message {
                lock(&log).push(bytes.to_vec());
            }
            if phone_sink.send(message).await.is_err() {
                break;
            }
        }
        up.abort();
    });
    (format!("ws://{address}"), seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_reaches_the_laptop_through_the_relay_which_sees_only_ciphertext() {
    let keys = generate_keypair();
    let companion = Companion::new(keys.private);
    let (url, seen) = test_relay().await;
    let mailbox = crate::qr::random::<16>();
    let phone_keys = generate_keypair();
    companion.set_phones(vec![(mailbox, phone_keys.public)]);
    companion.set_relay(Some(url.clone()), &[mailbox]);
    loop {
        if let Some(Event::Relay {
            connected: true, ..
        }) = companion.next_event().await
        {
            break;
        }
    }
    let (socket, _) =
        tokio_tungstenite::connect_async(format!("{url}/v1/{}?role=phone", hex::encode(mailbox)))
            .await
            .expect("phone");
    let (mut sink, mut stream) = socket.split();
    let header = InitHeader {
        version: PROTOCOL_VERSION,
        mode: Mode::Reconnect,
        id: mailbox,
    };
    let mut initiator =
        Initiator::new(&header, Some(&phone_keys.private), Some(&keys.public), None)
            .expect("initiator");
    let mut init = header.to_bytes().to_vec();
    init.extend(initiator.write_init(b"").expect("init"));
    sink.send(Message::Binary(wire::encode(Kind::Init, &init).into()))
        .await
        .expect("send");
    let Some(Ok(Message::Binary(reply))) = stream.next().await else {
        panic!("no reply")
    };
    let reply = parse(&reply).expect("frame");
    let (_, mut channel) = initiator
        .read_reply(&reply.payload, 1 << 20)
        .expect("reply");
    let secret = b"R1 value 4.7k on the phone";
    for sealed in channel.seal(secret).expect("seal") {
        sink.send(Message::Binary(wire::encode(Kind::Sealed, &sealed).into()))
            .await
            .expect("send");
    }
    let (session, ..) = next_handshake(&companion).await;
    assert!(companion.send(session, b"laptop secret: board_pins.h".to_vec()));
    let Some(Ok(Message::Binary(bytes))) = stream.next().await else {
        panic!("no message")
    };
    let frame = parse(&bytes).expect("frame");
    assert_eq!(
        channel.open(&frame.payload).expect("open").as_deref(),
        Some(&b"laptop secret: board_pins.h"[..])
    );
    let seen = lock(&seen).clone();
    assert!(seen.len() >= 3);
    for bytes in &seen {
        let frame = parse(bytes).expect("only companion frames pass the relay");
        assert!(matches!(
            frame.kind,
            Kind::Init | Kind::Reply | Kind::Sealed
        ));
        for plain in [&secret[..], b"laptop secret", b"board_pins"] {
            assert!(
                !bytes.windows(plain.len()).any(|w| w == plain),
                "plaintext through the relay"
            );
        }
    }
}

#[test]
fn addresses_are_ranked_private_first() {
    let ips: Vec<std::net::IpAddr> = [
        "127.0.0.1",
        "169.254.3.4",
        "192.168.1.5",
        "fd00::1",
        "2001:db8::1",
        "10.0.0.2",
        "8.8.8.8",
    ]
    .iter()
    .map(|s| s.parse().expect("ip"))
    .collect();
    let ranked = rank_addresses(&ips, 47120);
    assert_eq!(ranked.len(), 3);
    assert_eq!(ranked[0].ip().to_string(), "192.168.1.5");
    assert_eq!(ranked[1].ip().to_string(), "10.0.0.2");
    assert_eq!(ranked[2].ip().to_string(), "8.8.8.8");
}
