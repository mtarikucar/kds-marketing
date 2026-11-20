//! Paylaşımlar's batch reads and the post acknowledgement (design 2026-11-19 "Paylaşımlar and
//! Bilgi bankası" §3.7.4, §3.9, §3.10.2), the same for the PostgreSQL and the in-memory
//! repository: the materials and pieces of many rows in one read each, the Studio control read
//! without its lock, and a person's acknowledgement of a post recorded once.
use crate::fakes::FIXED_NOW;
use crate::studio_contract::{attach_post, ready, seed_material};
use jt_app::{error::ErrorCode, ports::UnitOfWork};
use jt_studio::{MaterialId, PostAck, SlotId};
use jt_tenancy::UserId;

pub async fn exercise(uow: &dyn UnitOfWork) {
    let f = ready(uow).await;
    let m = seed_material(uow, f.ws).await;
    let post = attach_post(uow, &f).await;

    let mut r = uow.tenant(f.ws).await.unwrap();
    // Many materials in one read: the stored ones, by id, an unknown id left out.
    assert_eq!(
        r.studio_materials()
            .get_materials(&[MaterialId::new_v7(), m.id, m.id])
            .await
            .unwrap(),
        [m.clone()]
    );
    assert!(
        r.studio_materials()
            .get_materials(&[])
            .await
            .unwrap()
            .is_empty()
    );
    // Many pieces in one read, each at the revision asked for.
    let one = r
        .studio()
        .get_piece(f.slot.id, f.slot.revision)
        .await
        .unwrap();
    let many = r
        .studio()
        .get_pieces(&[(f.slot.id, f.slot.revision), (SlotId::new_v7(), 1)])
        .await
        .unwrap();
    assert_eq!(many, one.map(|p| vec![(f.slot.id, p)]).unwrap_or_default());
    assert!(
        r.studio()
            .get_pieces(&[(f.slot.id, f.slot.revision + 100)])
            .await
            .unwrap()
            .is_empty()
    );
    // The control read without its lock answers what the lock would.
    let read = r.studio_control().read_control().await.unwrap();
    let locked = r.studio_control().lock_control().await.unwrap();
    assert_eq!(read.revision, locked.revision);
    assert_eq!(read.lanes, locked.lanes);
    assert_eq!(read.removed, locked.removed);
    r.commit().await.unwrap();

    // A person's acknowledgement is recorded once; the rest of the post is untouched.
    let ack = PostAck {
        by: UserId::new_v7(),
        at: FIXED_NOW,
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(r.studio_posts().acknowledge_post(post.slot_id, ack).await.unwrap());
    assert!(
        !r.studio_posts()
            .acknowledge_post(
                post.slot_id,
                PostAck {
                    by: UserId::new_v7(),
                    at: FIXED_NOW,
                },
            )
            .await
            .unwrap()
    );
    r.commit().await.unwrap();
    // A slot with no post is refused, in a bundle of its own (a refusal spoils its bundle).
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.studio_posts()
            .acknowledge_post(SlotId::new_v7(), ack)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(r);
    let mut r = uow.tenant(f.ws).await.unwrap();
    let stored = r.studio_posts().get_post(post.slot_id).await.unwrap().unwrap();
    assert_eq!(stored.acknowledged, Some(ack));
    assert_eq!(
        jt_studio::PlannedPost {
            acknowledged: None,
            ..stored
        },
        post
    );
}
