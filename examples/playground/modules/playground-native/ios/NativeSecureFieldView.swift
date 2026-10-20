import ExpoModulesCore
import UIKit

class NativeSecureFieldView: ExpoView {
  private let stack = UIStackView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    stack.axis = .vertical
    stack.spacing = 8
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
    stack.addArrangedSubview(makeField(placeholder: "Native secure field", secure: true))
    stack.addArrangedSubview(makeField(placeholder: "Native plain field", secure: false))
  }

  private func makeField(placeholder: String, secure: Bool) -> UITextField {
    let field = UITextField()
    field.placeholder = placeholder
    field.isSecureTextEntry = secure
    field.borderStyle = .roundedRect
    field.layer.borderWidth = 1
    field.layer.borderColor = UIColor.systemGray3.cgColor
    field.layer.cornerRadius = 6
    return field
  }
}
