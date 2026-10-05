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
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QHostAddress>
#include <QLabel>
#include <QNetworkAddressEntry>
#include <QNetworkInterface>
#include <QPushButton>
#include <QSpinBox>
#include <QVBoxLayout>
#include <QWidget>

namespace WebMixStartup {

namespace {

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
	    QObject::tr("All interfaces — 0.0.0.0 (reachable from the network, unauthenticated)"));

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

	auto *warning = new QLabel(QObject::tr("Anything other than 127.0.0.1 exposes an interface that has no "
					       "authentication. Use it only on a trusted network."),
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

} // namespace WebMixStartup
