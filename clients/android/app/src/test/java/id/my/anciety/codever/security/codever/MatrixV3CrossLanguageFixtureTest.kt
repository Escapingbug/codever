package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Static fixture generated only by packages/security's TypeScript implementation. */
class MatrixV3CrossLanguageFixtureTest {
    private val root = Json.parseToJsonElement(FIXTURE).jsonObject
    private val gatewayKey = PairingPublicKey(
        GATEWAY_ID,
        EcPublicJwk(GATEWAY_X, GATEWAY_Y),
    )
    private val recipient = TestP256Identity.fromPrivateJwk(
        EcPublicJwk(RECIPIENT_X, RECIPIENT_Y),
        RECIPIENT_D,
    )

    @Test
    fun `opens TypeScript v3 key grant and signed project event`() {
        val grant = MatrixV3Protocol.openProjectKeyGrant(
            state = root.getValue("state").jsonObject,
            identity = recipient,
            gatewayKey = gatewayKey,
            expectedWorkspaceId = WORKSPACE_ID,
            expectedRoomId = ROOM_ID,
            expectedCertificateId = CERTIFICATE_ID,
        )

        assertEquals(PROJECT_ID, grant.projectId)
        assertEquals("project-key-cross-v3", grant.activeKeyId)
        assertArrayEquals(ByteArray(32) { it.toByte() }, grant.activeKey().key)

        val opened = MatrixV3Protocol.openContent(
            extension = root.getValue("extension").jsonObject,
            roomId = ROOM_ID,
            projectId = PROJECT_ID,
            keys = grant,
        )
        assertEquals("event-cross-v3", opened.logicalEventId)
        assertEquals(
            "signed_event",
            opened.plaintext.getValue("kind").jsonPrimitive.content,
        )
        val signed = opened.plaintext.getValue("value").jsonObject
        val event = MatrixV3Protocol.verifyGatewayEvent(
            signed,
            gatewayKey,
            WORKSPACE_ID,
            PROJECT_ID,
        )
        assertEquals(
            "TypeScript v3 fixture 😀",
            event.getValue("payload").jsonObject.getValue("body").jsonPrimitive.content,
        )
    }

    @Test
    fun `TypeScript v3 fixture is bound to room certificate and Gateway signature`() {
        assertThrows(IllegalArgumentException::class.java) {
            MatrixV3Protocol.openProjectKeyGrant(
                root.getValue("state").jsonObject,
                recipient,
                gatewayKey,
                WORKSPACE_ID,
                "!other:example.org",
                CERTIFICATE_ID,
            )
        }
        val grant = MatrixV3Protocol.openProjectKeyGrant(
            root.getValue("state").jsonObject,
            recipient,
            gatewayKey,
            WORKSPACE_ID,
            ROOM_ID,
            CERTIFICATE_ID,
        )
        assertThrows(IllegalArgumentException::class.java) {
            MatrixV3Protocol.openContent(
                root.getValue("extension").jsonObject,
                "!other:example.org",
                PROJECT_ID,
                grant,
            )
        }
        val opened = MatrixV3Protocol.openContent(
            root.getValue("extension").jsonObject,
            ROOM_ID,
            PROJECT_ID,
            grant,
        )
        val signed = opened.plaintext.getValue("value").jsonObject
        val wrongGateway = TestP256Identity.generate().publicIdentity
        assertThrows(CodeverSecurityException::class.java) {
            MatrixV3Protocol.verifyGatewayEvent(
                signed,
                wrongGateway,
                WORKSPACE_ID,
                PROJECT_ID,
            )
        }
    }

    private companion object {
        const val GATEWAY_ID = "MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94"
        const val GATEWAY_X = "1siSvHSRoOQTkfn_uzHGRR7mlrF14hRSidQrrkSjQ7w"
        const val GATEWAY_Y = "JLwmVQAUZvm_JOBQI6wBY_h7sNz5TuA2ICpclQk3twA"
        const val RECIPIENT_X = "mWVAu202e4bily57jjvkdi6HGWmzSzGNryF1nmBDIBU"
        const val RECIPIENT_Y = "5wEWEx43GLsL1iSguFuTYCKignMfvdyP3NaVLm7sU7s"
        const val RECIPIENT_D = "YHhLk-Z1ytpzfgmrDGtysPBF6S1y1fb87EduZVIJkSo"
        const val WORKSPACE_ID = "workspace-cross-v3"
        const val PROJECT_ID = "project-cross-v3"
        const val ROOM_ID = "!project-v3:example.org"
        const val CERTIFICATE_ID = "certificate-cross-v3"
        val FIXTURE = """
{"gatewayId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","recipient":{"x":"mWVAu202e4bily57jjvkdi6HGWmzSzGNryF1nmBDIBU","y":"5wEWEx43GLsL1iSguFuTYCKignMfvdyP3NaVLm7sU7s","d":"YHhLk-Z1ytpzfgmrDGtysPBF6S1y1fb87EduZVIJkSo","keyId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg"},"state":{"kind":"project.key_grant","version":3,"workspaceId":"workspace-cross-v3","projectId":"project-cross-v3","roomId":"!project-v3:example.org","deviceId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","certificateId":"certificate-cross-v3","grantId":"grant-cross-v3","sealedGrant":{"envelope":{"kind":"codever.project-key-grant-envelope","version":3,"grantId":"grant-cross-v3","workspaceId":"workspace-cross-v3","projectId":"project-cross-v3","roomId":"!project-v3:example.org","deviceId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","certificateId":"certificate-cross-v3","senderKeyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","recipientKeyId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","nonce":"Rmi16I3c1kEilmTt","ciphertext":"f08R6A6Ye6hxItS-IBr-Nk_RWasAWw3HPr8jkWj8dJ9xWM00RkmmCt_qx7J0W2Mltac5BLCzUfIIRhEzdxjQ-YB80eWRRaWMndqFD-GeZeSddcLIw2UGXr7y-4QIwvIU-VgUHXRtJuwLrGeSBnvXDOdC7NgHy2OiTYPSE5t0wWYKSmsuIAG6ULGA0RDikFRaA8ODgauUtzc5jOsg7PYLrvyiaBJkSNAlD7rIxnx-5BUI0VzXXdi4w6rIUhjN8Yq524gCal4-0EEJ5dQ3zdbrirZ5OWwXQiqaWj9TiE0_t2DqK_18xtcO49jmUhtQt3_xeMhANxhi0g71bhXqAbgnqyKpEC26Tlrru_1bQmMSJQUeAFww7KcQOozJbDU63F8nOpKjak8-hTd8KfZpdAyhrH-EPGfX515CjBBkIZjKYyVPrfHGHoDahSxhTsVwAVhjIRZ-PCFrO_aiYPbzgC0gfk2cTVA9AXUgn73ZzZzU50RjNopo9TO_Xv3oyVFPKrA_I9GT6nIxz2UzAzfsmZ60GwneTncxMLYNfCM"},"signature":{"algorithm":"ES256","keyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","value":"UdpA_lIUvCifudkKh2FNMDU2UV7F8m7sLVs00RTZ7h63coptwSIoYnGQlZVZXStHh26DEBuZlPzIosNG-ERmhA"}}},"extension":{"version":3,"envelope":{"kind":"codever.project-envelope","version":3,"roomId":"!project-v3:example.org","projectId":"project-cross-v3","keyId":"project-key-cross-v3","logicalEventId":"event-cross-v3","nonce":"Bt2KVT9LwplGuKiv","ciphertext":"KUIeU2riUcjILh8vOtut3cc0nDLB7-RGVdBRetvuXe1OZboaQPBeb4TmuRzAapQnIod19RXJjgdhoFAVWHHaS7UnX3D2KEWn1f4Bh-NE7bQiMELlHXJsBo6BAllzFzZJCi3Lx4nFWARuYL2Cn1jRaeGCIgS4Q1OqP2p356fe2KPWlo-sVLP_KadNyNfeJZn5XkIigeFaGNFNPNyUWesItiMK-VbQjWMGKs5JbxK1im2FZG2H2u_RgzCmKz8WKIr6zdQjirAUKGuklrjxsKGVraZpLHNSnafKcKLJ8Pab-gN6zEEE1u-jlZ4Qe3wALD04UzcAGKGoXmdboPdk6nlyMemfAbTKrtFfkpInlSUbeHKcs8syQAEG2wr-1IvneO8zVW4qr3oCtBkQLcOhdbqZp0QPTAPFU381HANAi0CFpXlvTnBCmyfGwMAq6ZU45hRw5uScdxg_uTPYNedVh-Q4Q-77NRRaFXxRk7PEgj064baSDJPBg9hnTsodpEXNTcMd_IUkHhKcpi_5X4hWDqL0Dk9stooc8mtLnDqKxp2h_CxJQAD11bvYVEnsaI0U2o30r3QOS64BA6agTXVJPEncHYpICkPspRCZzuTDsZBWbd34KVJB-ecGDul9MQFx3BVLAmGbIBzRek5Mwd7aaAd9Z-Jm7b5owTKRxpjr7VRQNXbydCEcbVP1LKc-mXCtXmg3hzI6Jw58eX7J6Az9oQmCrO1FOW82WZin5a6mmPgzVHyczPKlgpuL7YHnrziL3DPrwFTE0zBV_NFl1UjCOKvvjV-7EACz6cOsZBY5gDT_EI39xziR5Gb7YN3eqg04ZZOkmf4Cu8cFwdMKaDaoyXJWnB4QwnoxBvSVLmbrslj_yvf5EEl71Z0IK90DnnpQyNiSkyt4zbzKlWpy29KV9NDwUrx3rPms2CmmQj8LteIlkxqUu2ciuPZ3uVFgS8ig6VaE_Fbe7c4dBlXuMlHd-4dDdiVAAfOKgrqGtd81CV_DSg"}}}
""".trimIndent()
    }
}
