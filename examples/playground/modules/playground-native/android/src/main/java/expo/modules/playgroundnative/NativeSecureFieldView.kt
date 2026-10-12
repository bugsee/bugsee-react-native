package expo.modules.playgroundnative

import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class NativeSecureFieldView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val column = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
  }

  init {
    column.addView(EditText(context).apply {
      hint = "Native secure field"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    })
    column.addView(EditText(context).apply {
      hint = "Native plain field"
    })
    addView(column)
  }
}
