package id.my.anciety.codever

import android.app.Application
import id.my.anciety.codever.matrix.MatrixSdkPlatform

class CodeverApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        MatrixSdkPlatform.initialize(this)
    }
}
