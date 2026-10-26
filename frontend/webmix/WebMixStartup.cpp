/******************************************************************************
    Copyright (C) 2025 WebMIX contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
******************************************************************************/

#include "WebMixStartup.hpp"

#include <QAbstractSocket>
#include <QCheckBox>
#include <QComboBox>
#include <QCoreApplication>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFormLayout>
#include <QHostAddress>
#include <QLabel>
#include <QNetworkAddressEntry>
#include <QNetworkInterface>
#include <QPushButton>
#include <QSettings>
#include <QSpinBox>
#include <QStandardPaths>
#include <QStringList>
#include <QVBoxLayout>
#include <QWidget>

namespace WebMixStartup {

namespace {

/*! What the sign-in entry passes: start from the executable's directory, and
 *  serve where this instance serves now, which also skips the chooser. */
QStringList AutostartArguments(const QString &host, quint16 port)
{
	return {QStringLiteral("--autostart"), QStringLiteral("--web-host"), host, QStringLiteral("--web-port"),
		QString::number(port)};
}

#if defined(_WIN32)
const QString kRunKey = QStringLiteral("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const QString kRunValue = QStringLiteral("WebMIX");
#elif !defined(__APPLE__)
QString DesktopEntryPath()
{
	return QStandardPaths::writableLocation(QStandardPaths::ConfigLocation) +
	       QStringLiteral("/autostart/webmix.desktop");
}

/*! One argument of a desktop entry's Exec key, quoted as the spec asks. */
QString ExecArgument(QString value)
{
	for (const char *special : {"\\", "\"", "`", "$"}) {
		value.replace(QLatin1String(special), QLatin1Char('\\') + QLatin1String(special));
	}
	return QLatin1Char('"') + value + QLatin1Char('"');
}
#endif

/*! Every address the machine can be reached on, best first.
 *
 * The loopback and the wildcard come first because they are the safe choices;
 * the LAN addresses are gathered from the interfaces that are actually up, so
 * a disconnected adapter is never offered. */
void CollectChoices(QComboBox *combo, const QString &current)
{
	int selected = -1;

	const auto add = [&](const QString &address, const QString &label) {
		combo->addItem(label, address);
		if (!current.isEmpty() && address == current) {
			selected = combo->count() - 1;
		}
	};

	add(QStringLiteral("127.0.0.1"), QObject::tr("This computer only — 127.0.0.1 (recommended)"));
	add(QStringLiteral("0.0.0.0"),
	    QObject::tr("All interfaces — 0.0.0.0 (reachable from the network, with sign-in)"));

	for (const QNetworkInterface &iface : QNetworkInterface::allInterfaces()) {
		const auto flags = iface.flags();
		if (!(flags & QNetworkInterface::IsUp) || !(flags & QNetworkInterface::IsRunning) ||
		    (flags & QNetworkInterface::IsLoopBack)) {
			continue;
		}
		for (const QNetworkAddressEntry &entry : iface.addressEntries()) {
			const QHostAddress address = entry.ip();
			if (address.protocol() != QAbstractSocket::IPv4Protocol || address.isLoopback() ||
			    address.isLinkLocal()) {
				continue;
			}
			add(address.toString(),
			    QObject::tr("%1 — %2").arg(iface.humanReadableName(), address.toString()));
		}
	}

	/* A host that is not one of ours (a hand-written global.ini, say) is kept,
	 * so opening the dialog never silently changes what the user configured. */
	if (selected < 0 && !current.isEmpty() && combo->findData(current) < 0) {
		combo->addItem(current, current);
		selected = combo->count() - 1;
	}

	combo->setCurrentIndex(selected >= 0 ? selected : 0);
}

} // namespace

bool AskEndpoint(QWidget *parent, QString &host, quint16 &port, bool &remember)
{
	QDialog dialog(parent);
	dialog.setWindowTitle(QObject::tr("WebMIX — where should the interface listen?"));
	dialog.setModal(true);

	auto *layout = new QVBoxLayout(&dialog);

	auto *intro = new QLabel(QObject::tr("The browser interface is served by OBS itself. Choose the address it "
					     "should listen on and the port to use."),
				 &dialog);
	intro->setWordWrap(true);
	layout->addWidget(intro);

	auto *form = new QFormLayout;

	auto *addressCombo = new QComboBox(&dialog);
	CollectChoices(addressCombo, host);
	form->addRow(QObject::tr("Address"), addressCombo);

	auto *portSpin = new QSpinBox(&dialog);
	portSpin->setRange(1, 65535);
	portSpin->setValue(port > 0 ? port : 4456);
	form->addRow(QObject::tr("Port"), portSpin);

	layout->addLayout(form);

	auto *warning = new QLabel(QObject::tr("Browsers on other computers have to sign in with the login set in "
					       "Tools > Web Interface Access; until one is set, only this computer "
					       "can use the interface. The connection is not encrypted, so use it on "
					       "a trusted network."),
				   &dialog);
	warning->setWordWrap(true);
	layout->addWidget(warning);

	auto *rememberBox = new QCheckBox(QObject::tr("Remember this choice and don't ask again"), &dialog);
	rememberBox->setChecked(false);
	layout->addWidget(rememberBox);

	auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
	buttons->button(QDialogButtonBox::Ok)->setText(QObject::tr("Start"));
	buttons->button(QDialogButtonBox::Cancel)->setText(QObject::tr("Quit"));
	layout->addWidget(buttons);

	QObject::connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
	QObject::connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);

	if (dialog.exec() != QDialog::Accepted) {
		return false;
	}

	host = addressCombo->currentData().toString();
	port = static_cast<quint16>(portSpin->value());
	remember = rememberBox->isChecked();
	return true;
}

bool AutostartSupported()
{
#ifdef __APPLE__
	return false;
#else
	return true;
#endif
}

bool AutostartEnabled()
{
#if defined(_WIN32)
	return QSettings(kRunKey, QSettings::NativeFormat).contains(kRunValue);
#elif defined(__APPLE__)
	return false;
#else
	return QFileInfo::exists(DesktopEntryPath());
#endif
}

bool SetAutostart(bool enable, const QString &host, quint16 port, QString &error)
{
	const QString program = QCoreApplication::applicationFilePath();

#if defined(_WIN32)
	QSettings run(kRunKey, QSettings::NativeFormat);
	if (enable) {
		const QString command = QLatin1Char('"') + QDir::toNativeSeparators(program) + QLatin1Char('"') +
					QLatin1Char(' ') + AutostartArguments(host, port).join(QLatin1Char(' '));
		run.setValue(kRunValue, command);
	} else {
		run.remove(kRunValue);
	}
	run.sync();
	if (run.status() != QSettings::NoError) {
		error = QStringLiteral("Could not write the Run key in the registry.");
		return false;
	}
	return true;
#elif defined(__APPLE__)
	Q_UNUSED(enable);
	Q_UNUSED(host);
	Q_UNUSED(port);
	Q_UNUSED(program);
	error = QStringLiteral("Starting at sign-in is not available on macOS.");
	return false;
#else
	const QString path = DesktopEntryPath();
	if (!enable) {
		if (QFile::exists(path) && !QFile::remove(path)) {
			error = QStringLiteral("Could not remove %1.").arg(path);
			return false;
		}
		return true;
	}

	if (!QDir().mkpath(QFileInfo(path).absolutePath())) {
		error = QStringLiteral("Could not create %1.").arg(QFileInfo(path).absolutePath());
		return false;
	}
	QStringList exec{ExecArgument(program)};
	for (const QString &argument : AutostartArguments(host, port)) {
		exec << ExecArgument(argument);
	}
	const QString entry =
		QStringLiteral("[Desktop Entry]\n"
			       "Type=Application\n"
			       "Name=WebMIX\n"
			       "Comment=OBS Studio with the WebMIX browser interface, started at sign-in\n"
			       "Exec=%1\n"
			       "Path=%2\n"
			       "Icon=com.obsproject.Studio\n"
			       "Terminal=false\n"
			       "X-GNOME-Autostart-enabled=true\n")
			.arg(exec.join(QLatin1Char(' ')), QFileInfo(program).absolutePath());

	QFile file(path);
	if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(entry.toUtf8()) < 0) {
		error = QStringLiteral("Could not write %1.").arg(path);
		return false;
	}
	return true;
#endif
}

} // namespace WebMixStartup
