package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.MatrixRoomBinding
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.security.codever.MatrixTransportBinding
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixSessionRepairPolicyTest {
    private val expected = MatrixTransportBinding(
        homeserver = "https://matrix.example",
        roomId = "!room:example",
        userId = "@phone:example",
        deviceId = "OLD_DEVICE",
        ed25519 = "old-key",
    )

    @Test
    fun `retained trust without a Matrix session requires repair`() {
        assertTrue(MatrixSessionRepairPolicy.requiredForTransport(expected, null))
        assertFalse(MatrixSessionRepairPolicy.requiredForTransport(null, null))
    }

    @Test
    fun `the exact trusted Matrix session remains healthy`() {
        assertFalse(MatrixSessionRepairPolicy.requiredForTransport(expected, session("OLD_DEVICE")))
    }

    @Test
    fun `a newly bootstrapped Matrix device remains in repair until recertified`() {
        assertTrue(MatrixSessionRepairPolicy.requiredForTransport(expected, session("NEW_DEVICE")))
    }

    @Test
    fun `same Gateway repair retains state authenticated by the replacement Matrix login`() {
        assertTrue(MatrixSessionRepairPolicy.retainSynchronizedGatewayState(true, true))
        assertFalse(MatrixSessionRepairPolicy.retainSynchronizedGatewayState(true, false))
        assertFalse(MatrixSessionRepairPolicy.retainSynchronizedGatewayState(false, true))
    }

    private fun session(deviceId: String) = PublicMatrixSession(
        homeserver = "https://matrix.example/",
        userId = "@phone:example",
        matrixDeviceId = deviceId,
        roomBinding = MatrixRoomBinding(
            roomId = "!room:example",
            gatewayId = "gateway",
            conversationId = "!room:example",
            gatewayUserId = "@gateway:example",
            gatewayDeviceId = "GATEWAY_DEVICE",
            gatewayDeviceEd25519 = "gateway-key",
        ),
    )
}
